(() => {
  "use strict";

  const els = {
    input: document.getElementById("report-input"),
    includeWipes: document.getElementById("include-wipes"),
    showAccounts: document.getElementById("show-accounts"),
    analyze: document.getElementById("analyze-button"),
    demo: document.getElementById("demo-button"),
    clear: document.getElementById("clear-button"),
    status: document.getElementById("status"),
    errors: document.getElementById("errors"),
    results: document.getElementById("results"),
    summaryStats: document.getElementById("summary-stats"),
    nightTitle: document.getElementById("night-title"),
    nightSubtitle: document.getElementById("night-subtitle"),
    awards: document.getElementById("awards-grid"),
    leaderboard: document.getElementById("leaderboard-body"),
    encounters: document.getElementById("encounter-list"),
    copy: document.getElementById("copy-button"),
  };

  const state = {
    worker: null,
    players: [],
    awards: [],
    logs: [],
    errors: [],
    sortKey: "deaths",
    sortDirection: -1,
    loading: false,
  };

  const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const oneDecimalFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

  function safeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseReportUrls(raw) {
    const candidates = String(raw || "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];

    for (let candidate of candidates) {
      if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
      let parsed;
      try { parsed = new URL(candidate); } catch { continue; }
      const host = parsed.hostname.toLowerCase();
      if (!["dps.report", "www.dps.report", "b.dps.report"].includes(host)) continue;
      const path = parsed.pathname.replace(/\/+$/, "");
      if (!path || path === "/" || path === "/api" || path === "/getJson") continue;
      const normalized = `https://${host === "www.dps.report" ? "dps.report" : host}${path}`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    return out;
  }

  function reportPath(url) {
    try { return new URL(url).pathname.slice(1); } catch { return url; }
  }

  function durationLabel(ms) {
    const total = Math.max(0, Math.round(safeNumber(ms) / 1000));
    if (!total) return "duration unknown";
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function setStatus(message, type = "") {
    els.status.textContent = message;
    els.status.className = `status ${type}`.trim();
  }

  function setBusy(busy) {
    state.loading = busy;
    els.analyze.disabled = busy;
    els.demo.disabled = busy;
    els.includeWipes.disabled = busy;
    els.analyze.textContent = busy ? "Analyzing…" : "Analyze the evidence";
  }

  function playerLabel(player) {
    return player?.displayName || player?.account || "Unknown";
  }

  function showErrors(errors) {
    els.errors.innerHTML = (errors || []).map(({ url, message }) => (
      `<div class="error-item"><strong>Could not load:</strong> ${escapeHtml(url)}<br>${escapeHtml(message)}</div>`
    )).join("");
  }

  function renderSummary(logs, players) {
    const kills = logs.filter((log) => log.success).length;
    const wipes = logs.length - kills;
    const names = [...new Set(logs.map((log) => log.fightName || "Unknown encounter"))];
    els.nightTitle.textContent = names.length === 1 ? `${names[0]} Awards` : "Raid Night Awards";
    els.nightSubtitle.textContent = names.length > 1
      ? `${names.length} encounter types entered the courtroom. The logs have spoken.`
      : "The logs have spoken. Appeals will not be considered.";

    const stats = [[logs.length, "logs"], [players.length, "players"], [kills, "kills"], [wipes, "wipes"]];
    els.summaryStats.innerHTML = stats.map(([value, label]) => (
      `<div class="summary-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
    )).join("");
  }

  function renderAwards(awards) {
    const showAccounts = els.showAccounts.checked;
    els.awards.innerHTML = (awards || []).map((item, index) => {
      const p = item.winner;
      return `<article class="award-card${item.featured || index === 0 ? " featured" : ""}">
        <div class="award-icon" aria-hidden="true">${escapeHtml(item.icon)}</div>
        <div>
          <div class="award-label">Raid Oscar</div>
          <h3 class="award-title">${escapeHtml(item.title)}</h3>
          <p class="award-winner">${escapeHtml(playerLabel(p))}</p>
          ${showAccounts && p?.account && p.account !== p.displayName ? `<div class="award-account">${escapeHtml(p.account)}</div>` : ""}
          <p class="award-stat">${escapeHtml(item.stat)}</p>
          <p class="award-roast">${escapeHtml(item.roast)}</p>
        </div>
      </article>`;
    }).join("");
  }

  function sortPlayers(players) {
    const key = state.sortKey;
    const dir = state.sortDirection;
    return [...players].sort((a, b) => {
      if (key === "displayName") return String(a.displayName).localeCompare(String(b.displayName)) * dir;
      return (safeNumber(a[key]) - safeNumber(b[key])) * dir;
    });
  }

  function renderLeaderboard(players) {
    const showAccounts = els.showAccounts.checked;
    els.leaderboard.innerHTML = sortPlayers(players).map((p) => `<tr>
      <td><span class="player-name">${escapeHtml(p.displayName)}</span>${showAccounts && p.account !== p.displayName ? `<span class="player-account">${escapeHtml(p.account)}</span>` : ""}</td>
      <td>${numberFmt.format(p.encounters)}</td>
      <td class="good-number">${numberFmt.format(p.dps)}</td>
      <td class="${p.deaths ? "bad-number" : ""}">${numberFmt.format(p.deaths)}</td>
      <td class="${p.downs ? "bad-number" : ""}">${numberFmt.format(p.downs)}</td>
      <td>${numberFmt.format(p.breakbar)}</td>
      <td>${numberFmt.format(p.resurrects)}</td>
      <td>${oneDecimalFmt.format(p.mechanicScorePerLog || 0)}</td>
      <td>${p.distanceWeight ? oneDecimalFmt.format(p.distance) : "—"}</td>
    </tr>`).join("");
  }

  function renderEncounters(logs) {
    els.encounters.innerHTML = logs.map((log) => `<div class="encounter-row ${log.success ? "success" : "wipe"}">
      <span class="encounter-dot" aria-hidden="true"></span>
      <div><div class="encounter-name">${escapeHtml(log.fightName)}</div><div class="encounter-meta">${escapeHtml(durationLabel(log.durationMS))} · ${numberFmt.format(log.playerCount || 0)} players</div></div>
      <span class="encounter-result">${log.success ? "Kill" : "Wipe"}</span>
      <a class="encounter-link" href="${escapeHtml(log.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reportPath(log.url))} ↗</a>
    </div>`).join("");
  }

  function renderAll() {
    renderSummary(state.logs, state.players);
    renderAwards(state.awards);
    renderLeaderboard(state.players);
    renderEncounters(state.logs);
    showErrors(state.errors);
    els.results.hidden = false;
  }

  function installWorker() {
    if (state.worker) state.worker.terminate();
    state.worker = new Worker("worker-v2.js?v=1");

    state.worker.onmessage = (event) => {
      const msg = event.data || {};

      if (msg.type === "progress") {
        setStatus(`Processed ${msg.done}/${msg.total} logs · ${msg.loaded} loaded${msg.failed ? ` · ${msg.failed} failed` : ""} · ${msg.current}`, "loading");
        return;
      }

      if (msg.type === "result") {
        state.players = Array.isArray(msg.players) ? msg.players : [];
        state.awards = Array.isArray(msg.awards) ? msg.awards : [];
        state.logs = Array.isArray(msg.logs) ? msg.logs : [];
        state.errors = Array.isArray(msg.errors) ? msg.errors : [];
        renderAll();
        setBusy(false);
        setStatus(`Done: ${state.logs.length} usable logs, ${state.players.length} players${state.errors.length ? `, ${state.errors.length} failed` : ""}.`, "success");
        if (!msg.recalc) els.results.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (msg.type === "fatal") {
        setBusy(false);
        setStatus(`Analysis failed: ${msg.message || "unknown worker error"}`);
      }
    };

    state.worker.onerror = (event) => {
      setBusy(false);
      setStatus(`Analysis worker crashed: ${event.message || "unknown error"}`);
    };
  }

  function analyze() {
    const urls = parseReportUrls(els.input.value);
    els.errors.innerHTML = "";
    els.results.hidden = true;

    if (!urls.length) {
      setStatus("Paste at least one valid dps.report encounter link.");
      return;
    }
    if (!("Worker" in window)) {
      setStatus("This browser does not support Web Workers, which are required for large raid nights.");
      return;
    }

    installWorker();
    setBusy(true);
    setStatus(`Starting ${urls.length} logs in the background…`, "loading");
    state.worker.postMessage({ type: "analyze", urls, includeWipes: els.includeWipes.checked });
  }

  function loadDemo() {
    const players = [
      { account: "Oops.7777", displayName: "Red Circle Enjoyer", profession: "Virtuoso", encounters: 3, dps: 28700, deaths: 5, downs: 8, breakbar: 1230, resurrects: 0, mechanicScorePerLog: 5.3, distance: 314, distanceWeight: 1, boonProvider: false },
      { account: "Greed.9001", displayName: "Parse Goblin", profession: "Soulbeast", encounters: 3, dps: 35100, deaths: 1, downs: 2, breakbar: 360, resurrects: 0, mechanicScorePerLog: 0.7, distance: 246, distanceWeight: 1, boonProvider: false },
      { account: "Hammer.5555", displayName: "Bonk Department", profession: "Scrapper", encounters: 3, dps: 22100, deaths: 1, downs: 1, breakbar: 8340, resurrects: 2, mechanicScorePerLog: 1.3, distance: 96, distanceWeight: 1, boonProvider: true },
      { account: "Medic.1234", displayName: "Definitely A Healer", profession: "Druid", encounters: 3, dps: 6500, deaths: 0, downs: 1, breakbar: 1920, resurrects: 18, mechanicScorePerLog: 0, distance: 112, distanceWeight: 1, boonProvider: true },
      { account: "Stack.2468", displayName: "Tag Attachment", profession: "Chronomancer", encounters: 3, dps: 15600, deaths: 0, downs: 0, breakbar: 2760, resurrects: 3, mechanicScorePerLog: 0, distance: 54, distanceWeight: 1, boonProvider: true },
    ];

    state.players = players;
    state.awards = [
      { icon: "💀", title: "Floor Inspector", winner: players[0], stat: "5 deaths across 3 logs", roast: "Most deaths in the submitted raid night. Nobody studied the arena texture pack more thoroughly.", featured: true },
      { icon: "🔥", title: "DPS Goblin", winner: players[1], stat: "35,100 weighted DPS over 3 logs", roast: "Highest damage rate among regular attendees. The boss health bars were treated as a personal grievance." },
      { icon: "📉", title: "Support Excuse Denied", winner: players[0], stat: "28,700 weighted DPS over 3 logs · no meaningful Quickness/Alacrity generation", roast: "Lowest damage rate among regular attendees who did not meaningfully provide Quickness or Alacrity. The ‘I was boon support’ defense has been formally denied." },
      { icon: "🔨", title: "Bonk Enthusiast", winner: players[2], stat: "2,780 breakbar damage per log", roast: "Best average blue-bar violence among regular attendees. When CC was requested, they actually located the button." },
    ];

    state.logs = [
      { url: "https://dps.report/demo-vg", fightName: "Vale Guardian", success: true, durationMS: 248000, playerCount: 5 },
      { url: "https://dps.report/demo-gors", fightName: "Gorseval", success: false, durationMS: 201000, playerCount: 5 },
      { url: "https://dps.report/demo-sab", fightName: "Sabetha", success: true, durationMS: 286000, playerCount: 5 },
    ];

    state.errors = [];
    renderAll();
    setStatus("Demo raid night loaded. No actual guildmates were harmed.", "success");
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearAll() {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    els.input.value = "";
    els.errors.innerHTML = "";
    els.results.hidden = true;
    state.players = [];
    state.awards = [];
    state.logs = [];
    state.errors = [];
    setBusy(false);
    setStatus("");
  }

  async function copySummary() {
    if (!state.awards.length) return;
    const lines = ["🏆 **GW2 RAID OSCARS**", ""];
    for (const item of state.awards) {
      lines.push(`${item.icon} **${item.title} — ${playerLabel(item.winner)}**`);
      lines.push(item.stat);
      lines.push(`_${item.roast}_`);
      lines.push("");
    }
    const text = lines.join("\n").trim();

    try {
      await navigator.clipboard.writeText(text);
      const old = els.copy.textContent;
      els.copy.textContent = "Copied ✓";
      setTimeout(() => { els.copy.textContent = old; }, 1400);
    } catch {
      window.prompt("Copy this summary:", text);
    }
  }

  els.analyze.addEventListener("click", analyze);
  els.demo.addEventListener("click", loadDemo);
  els.clear.addEventListener("click", clearAll);
  els.copy.addEventListener("click", copySummary);

  els.includeWipes.addEventListener("change", () => {
    if (!state.worker || state.loading || !state.logs.length) return;
    setStatus("Recalculating with the new wipe setting…", "loading");
    state.worker.postMessage({ type: "recalculate", includeWipes: els.includeWipes.checked });
  });

  els.showAccounts.addEventListener("change", () => {
    if (!state.players.length) return;
    renderAwards(state.awards);
    renderLeaderboard(state.players);
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.tabIndex = 0;
    const applySort = () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDirection *= -1;
      else {
        state.sortKey = key;
        state.sortDirection = key === "displayName" ? 1 : -1;
      }
      renderLeaderboard(state.players);
    };
    th.addEventListener("click", applySort);
    th.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        applySort();
      }
    });
  });
})();