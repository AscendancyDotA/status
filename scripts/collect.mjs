// Fetches the live status.json once and appends a compact sample to the history store.
// Usage: node scripts/collect.mjs <storeDir>   (storeDir = checkout of the `data` branch)
// Store layout:
//   days/YYYY-MM-DD.json  one compact JSON row per line inside a JSON array
//   summary.json          per-day [up, total] sample counts per service (90 days) -> uptime %
//   latest.json           last full status document (fallback for the page if live fetch fails)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const STATUS_URL = process.env.STATUS_URL ?? "https://binokel.tail108204.ts.net/status/status.json";
const KEEP_DAYS = 90;
const store = process.argv[2] ?? "store";
const daysDir = join(store, "days");
mkdirSync(daysDir, { recursive: true });

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const now = Math.floor(Date.now() / 1000);
const day = new Date(now * 1000).toISOString().slice(0, 10);

let doc = null, err = null;
for (let i = 0; i < 3 && !doc; i++) {
  try {
    const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "AscendancyDotA-status-collector" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    doc = await r.json();
    if (!doc || !Array.isArray(doc.services)) throw new Error("bad document");
  } catch (e) { err = String(e?.message ?? e); doc = null; await new Promise((r) => setTimeout(r, 5000)); }
}

const prev = readJson(join(store, "latest.json"), null);
const r1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : null);
const row = { t: now, up: {}, m: {} };
if (doc) {
  row.up.host = 1;
  for (const s of doc.services) {
    if (s.state === "pending") continue;
    row.up[s.id] = s.state === "up" ? 1 : s.state === "degraded" ? 0.5 : 0;
    for (const m of s.metrics ?? []) if (m.spark && m.value != null) row.m[`${s.id}.${m.key}`] = m.value;
  }
  const h = doc.host ?? {};
  row.m["host.cpu"] = r1(h.cpuPct);
  row.m["host.mem"] = h.memTotal ? r1((h.memUsed / h.memTotal) * 100) : null;
  row.m["host.disk"] = h.diskTotal ? r1((h.diskUsed / h.diskTotal) * 100) : null;
  row.m["host.load"] = r1(h.load?.[0]);
  if (h.egress?.ok) { row.m["host.tx"] = h.egress.tx; row.m["host.rx"] = h.egress.rx; }
  writeFileSync(join(store, "latest.json"), JSON.stringify({ fetched: now, doc }) + "\n");
} else {
  // exporter unreachable: box (and therefore everything behind the funnel) counts as down
  row.up.host = 0;
  for (const s of prev?.doc?.services ?? []) if (s.state !== "pending") row.up[s.id] = 0;
  row.err = err;
  if (prev) writeFileSync(join(store, "latest.json"), JSON.stringify({ ...prev, lastError: { t: now, err } }) + "\n");
}
for (const k of Object.keys(row.m)) if (row.m[k] == null) delete row.m[k];

// append row to today's file (array with one row per line keeps git diffs tiny)
const dayFile = join(daysDir, `${day}.json`);
const rows = readJson(dayFile, []);
rows.push(row);
writeFileSync(dayFile, "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");

// summary: per day and service [upSum, samples]
const sum = readJson(join(store, "summary.json"), { days: {} });
const d = (sum.days[day] ??= {});
for (const [id, v] of Object.entries(row.up)) { const a = (d[id] ??= [0, 0]); a[0] = Math.round((a[0] + v) * 10) / 10; a[1] += 1; }
sum.updated = now;

// retention
const cutoff = new Date((now - KEEP_DAYS * 86400) * 1000).toISOString().slice(0, 10);
for (const k of Object.keys(sum.days)) if (k < cutoff) delete sum.days[k];
for (const f of readdirSync(daysDir)) if (f.endsWith(".json") && f.slice(0, 10) < cutoff) unlinkSync(join(daysDir, f));
sum.files = readdirSync(daysDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).sort();
const ordered = Object.fromEntries(Object.entries(sum.days).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(store, "summary.json"), JSON.stringify({ updated: sum.updated, files: sum.files, days: ordered }) + "\n");

console.log(doc ? `ok: ${JSON.stringify(row)}` : `exporter unreachable: ${err}`);
