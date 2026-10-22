// status-exporter: tiny, dependency-free Bun HTTP service that publishes /status.json
// (aggregate counts only: no player names, IPs or secrets) for the AscendancyDotA status page.
// Config: /etc/status-exporter/config.json (override with STATUS_CONFIG env var).
import { readFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { cpus } from "node:os";

type Metric = { key: string; label: string; value: number | null; spark?: boolean; unit?: string };
type SvcCfg = {
  id: string; name: string; desc?: string; link?: string; linkLabel?: string;
  type: "http" | "systemd" | "teamspeak";
  enabled?: boolean;          // false => card shows "noch nicht eingerichtet"
  hidden?: boolean;           // true  => not published at all
  url?: string; timeoutMs?: number;
  metrics?: { key: string; path: string; label: string; spark?: boolean; unit?: string }[];
  unit?: string;              // systemd unit name (type systemd, optional extra check for others)
  udpPort?: number;           // teamspeak voice port, checked via `ss`
  query?: "webquery" | "serverquery" | "none";
  webqueryUrl?: string; apiKeyFile?: string;
  serverqueryHost?: string; serverqueryPort?: number; serverqueryCredFile?: string; virtualServerId?: number;
};
type Cfg = {
  listen?: string; port?: number; cacheMs?: number;
  iface?: string; disk?: string;
  egressAllowanceBytes?: number; egressWarnPct?: number;
  corsOrigin?: string;
  services: SvcCfg[];
};

const CFG_PATH = process.env.STATUS_CONFIG ?? "/etc/status-exporter/config.json";
const loadCfg = (): Cfg => JSON.parse(readFileSync(CFG_PATH, "utf8"));
let cfg = loadCfg();
process.on("SIGHUP", () => { try { cfg = loadCfg(); cache = null; console.log("config reloaded"); } catch (e) { console.error("reload failed", e); } });

const sh = (cmd: string[]): string => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    return p.success ? p.stdout.toString() : "";
  } catch { return ""; }
};
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null);
const pick = (o: any, path: string) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);

// ---- CPU usage: sampled from /proc/stat every 10 s ----
let prevCpu: number[] | null = null;
let cpuPct: number | null = null;
function sampleCpu() {
  const line = read("/proc/stat").split("\n")[0];
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4) return;
  const idle = v[3] + (v[4] ?? 0), total = v.reduce((a, b) => a + b, 0);
  if (prevCpu) {
    const dt = total - prevCpu[1], di = idle - prevCpu[0];
    if (dt > 0) cpuPct = Math.round((1 - di / dt) * 1000) / 10;
  }
  prevCpu = [idle, total];
}
sampleCpu(); setInterval(sampleCpu, 10_000);

function hostInfo() {
  const [l1, l5, l15] = read("/proc/loadavg").split(" ").map(Number);
  const mi: Record<string, number> = {};
  for (const l of read("/proc/meminfo").split("\n")) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mi[m[1]] = +m[2] * 1024; }
  const df = sh(["df", "-B1", "--output=size,used,avail", cfg.disk ?? "/"]).trim().split("\n")[1]?.trim().split(/\s+/).map(Number) ?? [];
  const up = Number(read("/proc/uptime").split(" ")[0]);
  return {
    cpus: cpus().length, cpuPct, load: [l1, l5, l15],
    memTotal: mi.MemTotal ?? null, memUsed: mi.MemTotal && mi.MemAvailable ? mi.MemTotal - mi.MemAvailable : null,
    diskTotal: df[0] ?? null, diskUsed: df[1] ?? null,
    uptimeS: Number.isFinite(up) ? Math.round(up) : null,
  };
}

// ---- Egress via vnstat (monthly) ----
function egress() {
  const iface = cfg.iface ?? "enp0s6";
  const allowance = cfg.egressAllowanceBytes ?? 10e12;
  const warnPct = cfg.egressWarnPct ?? 70;
  let j: any;
  try { j = JSON.parse(sh(["vnstat", "--json", "m", "2", "-i", iface])); } catch { return { ok: false, allowance, warnPct }; }
  const it = j?.interfaces?.[0];
  const now = new Date();
  const y = now.getUTCFullYear(), mo = now.getUTCMonth() + 1;
  const cur = (it?.traffic?.month ?? []).find((m: any) => m.date?.year === y && m.date?.month === mo);
  const tx = cur?.tx ?? 0, rx = cur?.rx ?? 0;
  const monthStart = Date.UTC(y, mo - 1, 1) / 1000;
  const monthEnd = Date.UTC(y, mo, 1) / 1000;
  const created = num(it?.created?.timestamp) ?? monthStart;
  const since = Math.max(monthStart, created);
  const nowS = now.getTime() / 1000;
  const elapsed = Math.max(1, nowS - since);
  // projection: average rate since measurement start, extrapolated to the full month
  const projected = Math.round(tx / elapsed * (monthEnd - monthStart));
  const pct = (tx / allowance) * 100, projPct = (projected / allowance) * 100;
  return {
    ok: true, iface, month: `${y}-${String(mo).padStart(2, "0")}`,
    tx, rx, since: Math.round(since), projected, allowance, warnPct,
    pct: Math.round(pct * 100) / 100, projectedPct: Math.round(projPct * 100) / 100,
    basisHours: Math.round(elapsed / 360) / 10,
    warn: projPct > warnPct,
  };
}

// ---- Service checks ----
async function httpJson(url: string, timeoutMs = 4000, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  const ms = Math.round(performance.now() - t0);
  let body: any = null;
  try { body = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body, ms };
}
const unitActive = (u: string) => sh(["systemctl", "is-active", u]).trim() === "active";
const udpListening = (port: number) => sh(["ss", "-Huln", `sport = :${port}`]).trim().length > 0;

function serverQuery(host: string, port: number, user: string, pass: string, sid: number, timeoutMs = 4000): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\//g, "\\/").replace(/ /g, "\\s").replace(/\|/g, "\\p");
    const s = connect(port, host);
    let buf = "", step = 0;
    const cmds = [`login ${esc(user)} ${esc(pass)}`, `use sid=${sid}`, "serverinfo", "quit"];
    const done = (e?: Error, v?: Record<string, string>) => { clearTimeout(to); s.destroy(); e ? reject(e) : resolve(v!); };
    const to = setTimeout(() => done(new Error("timeout")), timeoutMs);
    s.on("error", (e) => done(e));
    s.on("data", (d) => {
      buf += d.toString();
      if (step === 0 && buf.includes("TS3")) { buf = ""; s.write(cmds[0] + "\n"); step = 1; return; }
      const m = buf.match(/error id=(\d+)[^\n]*\n/);
      if (!m) return;
      if (m[1] !== "0") return done(new Error("query error " + m[1]));
      if (step === 3) {
        const info: Record<string, string> = {};
        for (const kv of buf.split("error id=")[0].trim().split(" ")) { const i = kv.indexOf("="); if (i > 0) info[kv.slice(0, i)] = kv.slice(i + 1); }
        s.write("quit\n");
        return done(undefined, info);
      }
      buf = ""; s.write(cmds[step] + "\n"); step++;
    });
  });
}

async function checkService(c: SvcCfg) {
  const base = { id: c.id, name: c.name, desc: c.desc ?? "", link: c.link ?? null, linkLabel: c.linkLabel ?? null };
  if (c.enabled === false) return { ...base, state: "pending", metrics: [] as Metric[] };
  const metrics: Metric[] = [];
  let state = "down", ms: number | null = null;
  try {
    if (c.type === "http") {
      const r = await httpJson(c.url!, c.timeoutMs);
      ms = r.ms;
      state = r.ok && (r.body?.ok ?? true) !== false ? "up" : "down";
      for (const m of c.metrics ?? []) metrics.push({ key: m.key, label: m.label, value: state === "up" ? num(pick(r.body, m.path)) : null, spark: m.spark, unit: m.unit });
      if (state === "up" && c.unit && !unitActive(c.unit)) state = "degraded";
    } else if (c.type === "systemd") {
      state = unitActive(c.unit!) ? "up" : "down";
    } else if (c.type === "teamspeak") {
      const listening = c.udpPort ? udpListening(c.udpPort) : true;
      let clients: number | null = null, max: number | null = null;
      try {
        let info: Record<string, any> | null = null;
        if (c.query === "webquery") {
          const key = read(c.apiKeyFile ?? "").trim();
          const sid = c.virtualServerId ?? 1;
          const r = await httpJson(`${c.webqueryUrl ?? "http://127.0.0.1:10080"}/${sid}/serverinfo`, c.timeoutMs, key ? { "x-api-key": key } : {});
          ms = r.ms;
          info = r.body?.body?.[0] ?? null;
        } else if (c.query === "serverquery") {
          const [user, pass] = read(c.serverqueryCredFile ?? "").trim().split(/\r?\n/);
          const t0 = performance.now();
          info = await serverQuery(c.serverqueryHost ?? "127.0.0.1", c.serverqueryPort ?? 10011, user ?? "", pass ?? "", c.virtualServerId ?? 1, c.timeoutMs);
          ms = Math.round(performance.now() - t0);
        }
        if (info) {
          const on = num(info.virtualserver_clientsonline), q = num(info.virtualserver_queryclientsonline) ?? 0;
          clients = on == null ? null : Math.max(0, on - q);
          max = num(info.virtualserver_maxclients);
        }
      } catch { /* query optional: port check decides up/down */ }
      state = listening ? "up" : "down";
      if (c.unit && !unitActive(c.unit)) state = listening ? "degraded" : "down";
      metrics.push({ key: "clients", label: "Nutzer online", value: clients, spark: true });
      if (max != null) metrics.push({ key: "slots", label: "Slots", value: max });
    }
  } catch { state = "down"; }
  return { ...base, state, ms, metrics };
}

let cache: { t: number; body: string } | null = null;
async function build() {
  const now = Date.now();
  if (cache && now - cache.t < (cfg.cacheMs ?? 5000)) return cache.body;
  const services = await Promise.all(cfg.services.filter((s) => !s.hidden).map(checkService));
  const body = JSON.stringify({ v: 1, t: Math.round(now / 1000), host: { ...hostInfo(), egress: egress() }, services });
  cache = { t: now, body };
  return body;
}

const server = Bun.serve({
  hostname: cfg.listen ?? "127.0.0.1",
  port: cfg.port ?? 8799,
  async fetch(req) {
    const h = {
      "access-control-allow-origin": cfg.corsOrigin ?? "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: h });
    // Any path returns the status document, so it works regardless of how the funnel mounts it.
    return new Response(await build(), { headers: { ...h, "content-type": "application/json; charset=utf-8" } });
  },
});
console.log(`status-exporter listening on ${server.hostname}:${server.port}`);
