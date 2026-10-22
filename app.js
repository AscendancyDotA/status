(() => {
  "use strict";
  const C = window.STATUS_CONFIG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (v, d = 0) => (v == null || !isFinite(v) ? "–" : v.toLocaleString("de-DE", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const pct = (v, d = 1) => (v == null ? "–" : nf(v, d) + " %");
  const bytes = (b, d = 1) => {
    if (b == null || !isFinite(b)) return "–";
    const u = ["B", "kB", "MB", "GB", "TB"]; let i = 0;
    while (Math.abs(b) >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return nf(b, i < 2 ? 0 : b < 10 ? 2 : b < 100 ? d : 0) + " " + u[i];
  };
  const dur = (s) => {
    if (s == null) return "–";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d} T ${h} Std` : h ? `${h} Std ${m} Min` : `${m} Min`;
  };
  const dtf = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const sdf = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const STATE = {
    up: "Online", degraded: "Eingeschränkt", down: "Offline",
    pending: "Noch nicht eingerichtet", unknown: "Unbekannt",
  };

  let live = null, liveAt = 0, liveErr = null, latest = null, summary = null, rows = [], range = 1;

  // ---------- data ----------
  async function getJson(url, opts = {}) {
    const r = await fetch(url, { cache: "no-store", ...opts });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function loadLive() {
    try {
      live = await getJson(C.liveUrl, { signal: AbortSignal.timeout(10000) });
      liveAt = Date.now(); liveErr = null;
    } catch (e) { liveErr = e; if (Date.now() - liveAt > 90000) live = null; }
    render();
  }
  async function loadHistory() {
    try {
      summary = await getJson(C.historyBase + "summary.json");
      latest = await getJson(C.historyBase + "latest.json").catch(() => latest);
      const cutoff = new Date(Date.now() - 8 * 86400e3).toISOString().slice(0, 10);
      const files = (summary.files || []).filter((d) => d >= cutoff);
      const parts = await Promise.all(files.map((d) => getJson(C.historyBase + "days/" + d + ".json").catch(() => [])));
      rows = parts.flat().sort((a, b) => a.t - b.t);
    } catch (e) { /* history is optional */ }
    render();
  }

  // ---------- history helpers ----------
  const series = (key) => {
    const from = Date.now() / 1000 - range * 86400;
    const pts = rows.filter((r) => r.t >= from && r.m && r.m[key] != null).map((r) => [r.t, r.m[key]]);
    const lv = liveValue(key);
    if (lv != null && (!pts.length || live.t > pts[pts.length - 1][0])) pts.push([live.t, lv]);
    return pts;
  };
  // current live value for a history key, so curves always reach "now"
  function liveValue(key) {
    if (!live) return null;
    const [id, k] = key.split(".");
    const h = live.host || {};
    if (id === "host") {
      if (k === "cpu") return h.cpuPct;
      if (k === "mem") return h.memTotal ? (h.memUsed / h.memTotal) * 100 : null;
      if (k === "disk") return h.diskTotal ? (h.diskUsed / h.diskTotal) * 100 : null;
      if (k === "load") return h.load ? h.load[0] : null;
      if (k === "tx" || k === "rx") return h.egress && h.egress.ok ? h.egress[k] : null;
      return null;
    }
    const s = (live.services || []).find((x) => x.id === id);
    const m = s && (s.metrics || []).find((x) => x.key === k);
    return m ? m.value : null;
  }
  function spark(key, cls = "") {
    const pts = series(key);
    if (pts.length < 2) return `<div class="rng">Verlauf folgt</div>`;
    const now = Date.now() / 1000, t0 = now - range * 86400;
    const vals = pts.map((p) => p[1]);
    const max = Math.max(...vals), mn = Math.min(...vals);
    const top = max > 0 ? max * 1.08 : 1;
    const X = (t) => ((t - t0) / (now - t0)) * 100, Y = (v) => 33 - (v / top) * 31;
    const segs = []; let cur = [];
    for (let i = 0; i < pts.length; i++) {
      if (i && pts[i][0] - pts[i - 1][0] > 2700) { segs.push(cur); cur = []; }
      cur.push(pts[i]);
    }
    segs.push(cur);
    let line = "", area = "";
    for (const s of segs) {
      const p = s.map(([t, v]) => `${X(t).toFixed(2)},${Y(v).toFixed(2)}`);
      if (s.length === 1) p.push(`${(X(s[0][0]) + 0.4).toFixed(2)},${Y(s[0][1]).toFixed(2)}`);
      line += "M" + p.join("L");
      area += `M${X(s[0][0]).toFixed(2)},33L` + p.join("L") + `L${X(s[s.length - 1][0]).toFixed(2)},33Z`;
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const f = key.endsWith(".tx") || key.endsWith(".rx") ? bytes : (v) => nf(v, 1);
    const lbl = key.endsWith(".tx") ? `${f(mn)} → ${f(max)}` : `min ${f(mn)} · Ø ${f(avg)} · max ${f(max)}`;
    return `<svg class="${cls}" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="Verlauf ${esc(lbl)}"><path class="spark-area" d="${area}"/><path class="spark-line" d="${line}"/></svg><div class="rng">${lbl}</div>`;
  }
  function uptimePct(id, days) {
    if (days === 1) {
      const from = Date.now() / 1000 - 86400;
      const v = rows.filter((r) => r.t >= from && r.up && r.up[id] != null).map((r) => r.up[id]);
      return v.length ? (v.reduce((a, b) => a + b, 0) / v.length) * 100 : null;
    }
    if (!summary) return null;
    const keys = Object.keys(summary.days).sort().slice(-days);
    let u = 0, n = 0;
    for (const k of keys) { const a = summary.days[k][id]; if (a) { u += a[0]; n += a[1]; } }
    return n ? (u / n) * 100 : null;
  }
  function uptimeBlock(id) {
    const today = new Date();
    let bars = "";
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400e3).toISOString().slice(0, 10);
      const a = summary?.days?.[d]?.[id];
      const p = a && a[1] ? (a[0] / a[1]) * 100 : null;
      const c = p == null ? "" : p >= 99.5 ? "u-ok" : p >= 95 ? "u-warn" : "u-bad";
      bars += `<i class="${c}" title="${d.split("-").reverse().join(".")}: ${p == null ? "keine Daten" : nf(p, 2) + " %"}"></i>`;
    }
    const f = (d) => { const p = uptimePct(id, d); return p == null ? "–" : nf(p, p === 100 ? 0 : 2) + " %"; };
    return `<div class="uptime"><div class="bars" aria-label="Verfügbarkeit der letzten 90 Tage">${bars}</div>
      <div class="upline"><span>vor 90 Tagen</span><span>heute</span></div>
      <div class="upsum">Verfügbarkeit: <span>24 h <b>${f(1)}</b></span> · <span>7 T <b>${f(7)}</b></span> · <span>30 T <b>${f(30)}</b></span> · <span>90 T <b>${f(90)}</b></span></div></div>`;
  }
  const metricBox = (value, label, sparkKey, cls = "") =>
    `<div class="metric"><div class="v">${value}</div><div class="l">${esc(label)}</div>${sparkKey ? spark(sparkKey, cls) : ""}</div>`;
  const pill = (st) => `<span class="pill s-${st}"><span class="dot s-${st}"></span>${STATE[st] ?? st}</span>`;

  // ---------- render ----------
  function render() {
    const doc = live ?? latest?.doc ?? null;
    const isLive = !!live;
    const svcs = (doc?.services ?? []).map((s) => ({ ...s, state: isLive || s.state === "pending" ? s.state : "unknown" }));

    // overall
    const ov = $("#overall"), ot = $("#overall-text");
    ov.className = "overall";
    if (!doc) { ot.textContent = liveErr ? "Server nicht erreichbar" : "Lade Live-Daten …"; if (liveErr) ov.classList.add("s-down"); }
    else if (!isLive) { ot.textContent = "Server nicht erreichbar"; ov.classList.add("s-down"); }
    else {
      const bad = svcs.filter((s) => s.state === "down"), deg = svcs.filter((s) => s.state === "degraded");
      if (bad.length) { ot.textContent = "Störung: " + bad.map((s) => s.name).join(", "); ov.classList.add("s-down"); }
      else if (deg.length) { ot.textContent = "Eingeschränkt: " + deg.map((s) => s.name).join(", "); ov.classList.add("s-degraded"); }
      else { ot.textContent = "Alle Dienste laufen"; ov.classList.add("s-up"); }
    }
    $("#updated").textContent = isLive
      ? `Live · Stand ${tf.format(new Date(doc.t * 1000))} · aktualisiert alle ${C.refreshMs / 1000} s`
      : latest ? `Letzter gespeicherter Stand: ${dtf.format(new Date(latest.fetched * 1000))}` : " ";

    // services
    let html = "";
    if (!isLive && doc) html += `<div class="banner">Live-Daten gerade nicht erreichbar – angezeigt wird der letzte gespeicherte Stand. Neuer Versuch alle ${C.refreshMs / 1000} s.</div>`;
    for (const s of svcs) {
      const link = s.link && s.state !== "pending" ? ` <a class="small" href="${esc(s.link)}">${esc(s.linkLabel || "Öffnen")} →</a>` : "";
      html += `<article class="card s-${s.state}"><div class="chead"><div class="title"><h3>${esc(s.name)}</h3><span class="sub">${esc(s.desc)}</span>${link}</div>${pill(s.state)}</div>`;
      if (s.state === "pending") {
        html += `<p class="note info">Dieser Dienst wird gerade eingerichtet und erscheint hier automatisch, sobald er läuft.</p>`;
      } else {
        const ms = s.metrics ?? [];
        if (ms.length) html += `<div class="metrics">${ms.map((m) => metricBox(m.value == null ? "–" : nf(m.value) + (m.unit ? " " + esc(m.unit) : ""), m.label, m.spark ? `${s.id}.${m.key}` : null)).join("")}</div>`;
        html += uptimeBlock(s.id);
      }
      html += `</article>`;
    }
    $("#services").innerHTML = html || `<p class="small">Noch keine Daten.</p>`;

    // host
    const h = doc?.host;
    if (h) {
      const memP = h.memTotal ? (h.memUsed / h.memTotal) * 100 : null, diskP = h.diskTotal ? (h.diskUsed / h.diskTotal) * 100 : null;
      const meter = (p) => `<div class="meter${p > 90 ? " bad" : p > 75 ? " warn" : ""}"><span style="width:${Math.min(100, p ?? 0).toFixed(1)}%"></span></div>`;
      $("#host").innerHTML = `<div class="chead"><div class="title"><h3>Oracle-Server</h3><span class="sub">${h.cpus} vCPU · ${bytes(h.memTotal)} RAM</span></div>${pill(isLive ? "up" : "unknown")}</div>
        <div class="metrics">
          ${metricBox(pct(h.cpuPct), "CPU-Auslastung", "host.cpu")}
          ${metricBox(h.load ? nf(h.load[0], 2) : "–", h.load ? `Load · 5/15 min: ${nf(h.load[1], 2)} / ${nf(h.load[2], 2)}` : "Load", "host.load")}
          ${metricBox(pct(memP), `RAM · ${bytes(h.memUsed)} von ${bytes(h.memTotal)}`, "host.mem")}
          <div class="metric"><div class="v">${pct(diskP)}</div><div class="l">Speicher · ${bytes(h.diskUsed)} von ${bytes(h.diskTotal)}</div>${meter(diskP)}</div>
          ${metricBox(dur(h.uptimeS), "Laufzeit seit Neustart")}
        </div>${uptimeBlock("host")}`;
      const e = h.egress;
      if (e && e.ok) {
        const used = e.pct, proj = e.projectedPct, bad = proj > 100;
        const cls = bad ? " bad" : e.warn ? " warn" : "";
        const early = e.basisHours < 24;
        $("#egress").innerHTML = `<div class="chead"><div class="title"><h3>Ausgehender Traffic</h3><span class="sub">${esc(e.month.split("-").reverse().join("/"))} · Oracle Free Tier: ${bytes(e.allowance, 0)} / Monat frei</span></div>${pill(bad ? "down" : e.warn ? "degraded" : "up").replace(/Online|Eingeschränkt|Offline/, bad ? "Über Freikontingent" : e.warn ? "Achtung" : "Im Rahmen")}</div>
          <div class="metrics">
            <div class="metric" style="grid-column:1/-1"><div class="egress-big">${bytes(e.tx)} <span class="small">von ${bytes(e.allowance, 0)} · ${used < 0.01 ? "< 0,01" : nf(used, used < 1 ? 2 : 1)} %</span></div>
              <div class="meter${cls}" title="Verbraucht ${nf(used, 2)} %, Hochrechnung ${nf(proj, 1)} %"><span class="proj" style="width:${Math.min(100, proj).toFixed(2)}%"></span><span style="width:${Math.min(100, used).toFixed(2)}%"></span><i class="mark" style="left:${e.warnPct}%"></i></div>
              <div class="l">Hochrechnung Monatsende: <b>${bytes(e.projected)}</b> (${proj < 0.01 ? "< 0,01" : nf(proj, proj < 1 ? 2 : 1)} %) · Warnschwelle ${e.warnPct} %</div>
              ${spark("host.tx", cls.trim())}</div>
            ${metricBox(bytes(e.rx), "Eingehend (kostenlos)")}
            ${metricBox(sdf.format(new Date(e.since * 1000)).replace(",", ""), "gemessen seit (vnStat)")}
          </div>
          ${e.warn ? `<p class="note">Die Hochrechnung liegt über ${e.warnPct} % des kostenlosen Kontingents. Über ${bytes(e.allowance, 0)} hinaus berechnet Oracle ausgehenden Traffic.</p>` : ""}
          ${early ? `<p class="note info">Messung läuft erst seit ${nf(e.basisHours, 1)} Std – die Hochrechnung wird mit der Zeit genauer.</p>` : ""}
          <p class="small">Gemessen an der Netzwerkkarte des Servers (inkl. Tailscale-Verkehr). Abrechnungsdaten von Oracle selbst werden nicht abgefragt.</p>`;
      } else $("#egress").innerHTML = `<h3>Ausgehender Traffic</h3><p class="small">Keine Messdaten (vnStat).</p>`;
    } else $("#host").innerHTML = `<p class="small">${liveErr ? "Server nicht erreichbar." : "Lade …"}</p>`;
  }

  document.querySelectorAll(".range button").forEach((b) => b.addEventListener("click", () => {
    range = +b.dataset.range;
    document.querySelectorAll(".range button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  loadHistory(); loadLive();
  setInterval(loadLive, C.refreshMs);
  setInterval(loadHistory, C.historyRefreshMs);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadLive(); });
})();
