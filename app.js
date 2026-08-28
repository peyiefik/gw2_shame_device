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
    logs: [],
    players: [],
    awards: [],
    sortKey: "deaths",
    sortDirection: -1,
  };

  const severityWeight = { Sev0: 0.5, Sev1: 1, Sev2: 2, Sev3: 4, Sev4: 7 };
  const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const oneDecimalFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

  function safeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function firstPhase(array) {
    return Array.isArray(array) && array.length ? (array[0] || {}) : {};
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

    const out = [];
    const seen = new Set();

    for (let candidate of candidates) {
      if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
      let parsed;
      try {
        parsed = new URL(candidate);
      } catch {
        continue;
      }

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

  async function fetchLog(reportUrl) {
    const endpoints = ["https://dps.report/getJson", "https://b.dps.report/getJson"];
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const requestUrl = `${endpoint}?permalink=${encodeURIComponent(reportUrl)}`;
        const response = await fetch(requestUrl, { method: "GET", mode: "cors" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (!json || !Array.isArray(json.players)) throw new Error("The report returned no Elite Insights player data.");
        return json;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Could not load this report.");
  }

  function encounterName(log) {
    return log.fightName || log.encounterName || firstPhase(log.phases).name || firstPhase(log.targets).name || "Unknown encounter";
  }

  function durationLabel(ms) {
    const total = Math.max(0, Math.round(safeNumber(ms) / 1000));
    if (!total) return "duration unknown";
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function reportPath(url) {
    try { return new URL(url).pathname.slice(1); } catch { return url; }
  }

  function emptyPlayer(account, name, profession) {
    return {
      account,
      displayName: name || account || "Unknown player",
      profession: profession || "Unknown",
      characters: new Set(name ? [name] : []),
      encounters: 0,
      successes: 0,
      wipes: 0,
      activeMs: 0,
      totalDamage: 0,
      fallbackDpsSum: 0,
      fallbackDpsCount: 0,
      deaths: 0,
      downs: 0,
      downDuration: 0,
      damageTaken: 0,
      dodges: 0,
      breakbar: 0,
      resurrects: 0,
      resurrectTime: 0,
      cleanses: 0,
      boonStrips: 0,
      wastedCasts: 0,
      castUptimeWeighted: 0,
      castUptimeWeight: 0,
      distanceWeighted: 0,
      distanceWeight: 0,
      mechanicScore: 0,
      mechanicEvents: 0,
      mechanicNames: new Map(),
      dps: 0,
      distance: 0,
      castUptime: 0,
    };
  }

  function aggregateLogs(logEntries, includeWipes) {
    const map = new Map();
    const includedLogs = logEntries.filter(({ data }) => includeWipes || data.success === true);

    for (const { data } of includedLogs) {
      const characterToAccount = new Map();
      const perLogAccounts = new Set();

      for (const player of data.players || []) {
        if (player.notInSquad || player.friendlyNPC) continue;
        const account = String(player.account || player.name || "Unknown");
        const character = String(player.name || account);
        characterToAccount.set(character, account);

        if (!map.has(account)) map.set(account, emptyPlayer(account, character, player.profession));
        const agg = map.get(account);
        agg.displayName = agg.displayName || character;
        agg.profession = player.profession || agg.profession;
        agg.characters.add(character);

        const dps = firstPhase(player.dpsAll);
        const defense = firstPhase(player.defenses);
        const support = firstPhase(player.support);
        const stats = firstPhase(player.statsAll);
        const activeMs = safeNumber(firstPhase(player.activeTimes), safeNumber((player.activeTimes || [])[0], 0));
        const weight = activeMs > 0 ? activeMs : Math.max(1, safeNumber(data.durationMS, 1));

        agg.activeMs += activeMs;
        agg.totalDamage += safeNumber(dps.damage);
        if (safeNumber(dps.dps) > 0) {
          agg.fallbackDpsSum += safeNumber(dps.dps);
          agg.fallbackDpsCount += 1;
        }
        agg.breakbar += safeNumber(dps.breakbarDamage);
        agg.deaths += safeNumber(defense.deadCount);
        agg.downs += safeNumber(defense.downCount);
        agg.downDuration += safeNumber(defense.downDuration);
        agg.damageTaken += safeNumber(defense.damageTaken);
        agg.dodges += safeNumber(defense.dodgeCount);
        agg.resurrects += safeNumber(support.resurrects);
        agg.resurrectTime += safeNumber(support.resurrectTime);
        agg.cleanses += safeNumber(support.condiCleanse);
        agg.boonStrips += safeNumber(support.boonStrips);
        agg.wastedCasts += safeNumber(stats.wasted);

        const castUptime = safeNumber(stats.skillCastUptime, NaN);
        if (Number.isFinite(castUptime)) {
          agg.castUptimeWeighted += castUptime * weight;
          agg.castUptimeWeight += weight;
        }

        const distance = safeNumber(stats.distToCom, NaN);
        if (Number.isFinite(distance) && distance >= 0) {
          agg.distanceWeighted += distance * weight;
          agg.distanceWeight += weight;
        }

        if (!perLogAccounts.has(account)) {
          perLogAccounts.add(account);
          agg.encounters += 1;
          if (data.success === true) agg.successes += 1;
          else agg.wipes += 1;
        }
      }

      for (const mechanic of data.mechanics || []) {
        const weight = severityWeight[mechanic.severity] ?? 1;
        const mechanicName = mechanic.name || mechanic.fullName || "Unknown mechanic";
        for (const event of mechanic.mechanicsData || []) {
          const account = characterToAccount.get(event.actor);
          if (!account || !map.has(account)) continue;
          const agg = map.get(account);
          const eventWeight = Math.max(0.1, safeNumber(event.weight, 1));
          agg.mechanicScore += weight * eventWeight;
          agg.mechanicEvents += 1;
          agg.mechanicNames.set(mechanicName, (agg.mechanicNames.get(mechanicName) || 0) + 1);
        }
      }
    }

    const players = [...map.values()];
    for (const p of players) {
      p.dps = p.activeMs > 0
        ? p.totalDamage / (p.activeMs / 1000)
        : (p.fallbackDpsCount ? p.fallbackDpsSum / p.fallbackDpsCount : 0);
      p.distance = p.distanceWeight ? p.distanceWeighted / p.distanceWeight : 0;
      p.castUptime = p.castUptimeWeight ? p.castUptimeWeighted / p.castUptimeWeight : 0;
      p.characters = [...p.characters];
    }
    return { players, includedLogs };
  }

  function top(players, key, predicate = () => true) {
    return players.filter(predicate).sort((a, b) => safeNumber(b[key]) - safeNumber(a[key]))[0] || null;
  }

  function bottom(players, key, predicate = () => true) {
    return players.filter(predicate).sort((a, b) => safeNumber(a[key]) - safeNumber(b[key]))[0] || null;
  }

  function award(id, icon, title, winner, stat, roast, featured = false) {
    return { id, icon, title, winner, stat, roast, featured };
  }

  function buildAwards(players) {
    if (!players.length) return [];
    const awards = [];

    const floor = top(players, "deaths", (p) => p.deaths > 0);
    if (floor) awards.push(award("floor", "💀", "Floor Inspector", floor, `${numberFmt.format(floor.deaths)} death${floor.deaths === 1 ? "" : "s"}`, "The floor has been checked. Thoroughly.", true));

    const downs = top(players, "downs", (p) => p.downs > 0);
    if (downs) awards.push(award("downstate", "🛌", "Downstate Connoisseur", downs, `${numberFmt.format(downs.downs)} down${downs.downs === 1 ? "" : "s"}`, "Why stand when Tyria provides a perfectly good floor?"));

    const dps = top(players, "dps", (p) => p.dps > 0);
    if (dps) awards.push(award("dps", "🔥", "DPS Goblin", dps, `${numberFmt.format(dps.dps)} DPS`, "Numbers were harmed in the making of this parse."));

    const cc = top(players, "breakbar", (p) => p.breakbar > 0);
    if (cc) awards.push(award("cc", "🔨", "Bonk Enthusiast", cc, `${numberFmt.format(cc.breakbar)} breakbar damage`, "Saw a blue bar and took it personally."));

    const res = top(players, "resurrects", (p) => p.resurrects > 0);
    if (res) awards.push(award("res", "🚑", "Ambulance", res, `${numberFmt.format(res.resurrects)} resurrection${res.resurrects === 1 ? "" : "s"}`, "Keeping the squad legally classified as alive."));

    const cleanse = top(players, "cleanses", (p) => p.cleanses > 0);
    if (cleanse) awards.push(award("cleanse", "🧹", "Condition Janitor", cleanse, `${numberFmt.format(cleanse.cleanses)} cleanses`, "Someone had to clean up this mess."));

    const strips = top(players, "boonStrips", (p) => p.boonStrips > 0);
    if (strips) awards.push(award("strip", "🫳", "Boon Repo Agent", strips, `${numberFmt.format(strips.boonStrips)} boon strips`, "Your boons? Our boons."));

    const sponge = top(players, "damageTaken", (p) => p.damageTaken > 0);
    if (sponge) awards.push(award("sponge", "🧽", "Damage Sponge", sponge, `${numberFmt.format(sponge.damageTaken)} damage taken`, "Mitigation strategy: face."));

    const orbit = top(players, "distance", (p) => p.distance > 0 && p.distanceWeight > 0);
    if (orbit) awards.push(award("orbit", "🛰️", "Independent Contractor", orbit, `${oneDecimalFmt.format(orbit.distance)} avg. commander distance`, "Technically in the squad. Spiritually in another instance."));

    const pet = bottom(players, "distance", (p) => p.distance > 0 && p.distanceWeight > 0);
    if (pet && (!orbit || pet.account !== orbit.account)) awards.push(award("pet", "🐥", "Commander's Emotional Support", pet, `${oneDecimalFmt.format(pet.distance)} avg. commander distance`, "If the tag moves, they move."));

    const buttons = top(players, "castUptime", (p) => p.castUptime > 0);
    if (buttons) awards.push(award("buttons", "⌨️", "Button Presser", buttons, `${oneDecimalFmt.format(buttons.castUptime)}% cast uptime`, "There were keys. They were pressed."));

    const wasted = top(players, "wastedCasts", (p) => p.wastedCasts > 0);
    if (wasted) awards.push(award("wasted", "🫠", "Changed My Mind Mid-Cast", wasted, `${numberFmt.format(wasted.wastedCasts)} interrupted casts`, "Commitment remains optional."));

    const mechanic = top(players, "mechanicScore", (p) => p.mechanicEvents > 0);
    if (mechanic) awards.push(award("mechanics", "🎯", "Mechanic Magnet", mechanic, `${numberFmt.format(mechanic.mechanicEvents)} EI mechanic appearances`, "If Elite Insights wrote it down, somehow they were involved."));

    let specific = null;
    for (const p of players) {
      for (const [name, count] of p.mechanicNames.entries()) {
        if (count < 2) continue;
        if (!specific || count > specific.count) specific = { player: p, name, count };
      }
    }
    if (specific) awards.push(award("specific", "📌", `${specific.name} Specialist`, specific.player, `${specific.count} appearances`, `At this point ${specific.name} may be a hobby.`));

    const survivor = [...players]
      .filter((p) => p.encounters >= Math.max(1, Math.floor(Math.max(...players.map((x) => x.encounters)) * 0.7)))
      .sort((a, b) => a.deaths - b.deaths || b.encounters - a.encounters || b.dps - a.dps)[0];
    if (survivor && survivor.deaths === 0) awards.push(award("survivor", "🪳", "Unreasonably Alive", survivor, `0 deaths across ${survivor.encounters} log${survivor.encounters === 1 ? "" : "s"}`, "Refused to participate in the floor meta."));

    const featuredIndex = awards.findIndex((a) => a.featured);
    if (featuredIndex < 0 && awards.length) awards[0].featured = true;
    return awards.slice(0, 12);
  }

  function playerLabel(player) {
    return player?.displayName || player?.account || "Unknown";
  }

  function renderSummary(includedLogs, players) {
    const kills = includedLogs.filter(({ data }) => data.success === true).length;
    const wipes = includedLogs.length - kills;
    const names = [...new Set(includedLogs.map(({ data }) => encounterName(data)))];
    els.nightTitle.textContent = names.length === 1 ? `${names[0]} Awards` : "Raid Night Awards";
    els.nightSubtitle.textContent = names.length > 1
      ? `${names.length} encounter types entered the courtroom. The logs have spoken.`
      : "The logs have spoken. Appeals will not be considered.";

    const stats = [
      [includedLogs.length, "logs"],
      [players.length, "players"],
      [kills, "kills"],
      [wipes, "wipes"],
    ];
    els.summaryStats.innerHTML = stats.map(([value, label]) => `<div class="summary-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  }

  function renderAwards(awards) {
    const showAccounts = els.showAccounts.checked;
    els.awards.innerHTML = awards.map((item) => {
      const p = item.winner;
      return `<article class="award-card${item.featured ? " featured" : ""}">
        <div class="award-icon" aria-hidden="true">${item.icon}</div>
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
      if (key === "displayName") return a.displayName.localeCompare(b.displayName) * dir;
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
      <td>${numberFmt.format(p.mechanicEvents)}</td>
      <td>${p.distanceWeight ? oneDecimalFmt.format(p.distance) : "—"}</td>
    </tr>`).join("");
  }

  function renderEncounters(logEntries) {
    els.encounters.innerHTML = logEntries.map(({ url, data }) => {
      const success = data.success === true;
      const playerCount = (data.players || []).filter((p) => !p.notInSquad && !p.friendlyNPC).length;
      return `<div class="encounter-row ${success ? "success" : "wipe"}">
        <span class="encounter-dot" aria-hidden="true"></span>
        <div><div class="encounter-name">${escapeHtml(encounterName(data))}</div><div class="encounter-meta">${escapeHtml(durationLabel(data.durationMS))} · ${playerCount} players</div></div>
        <span class="encounter-result">${success ? "Kill" : "Wipe"}</span>
        <a class="encounter-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reportPath(url))} ↗</a>
      </div>`;
    }).join("");
  }

  function renderAll() {
    const { players, includedLogs } = aggregateLogs(state.logs, els.includeWipes.checked);
    state.players = players;
    state.awards = buildAwards(players);
    renderSummary(includedLogs, players);
    renderAwards(state.awards);
    renderLeaderboard(players);
    renderEncounters(includedLogs);
    els.results.hidden = false;
  }

  function setStatus(message, type = "") {
    els.status.textContent = message;
    els.status.className = `status ${type}`.trim();
  }

  function showErrors(errors) {
    els.errors.innerHTML = errors.map(({ url, message }) => `<div class="error-item"><strong>Could not load:</strong> ${escapeHtml(url)}<br>${escapeHtml(message)}</div>`).join("");
  }

  async function analyze() {
    const urls = parseReportUrls(els.input.value);
    els.errors.innerHTML = "";
    els.results.hidden = true;

    if (!urls.length) {
      setStatus("Paste at least one valid dps.report encounter link.");
      return;
    }

    els.analyze.disabled = true;
    els.demo.disabled = true;
    const loaded = [];
    const errors = [];

    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      setStatus(`Loading log ${i + 1} of ${urls.length}: ${reportPath(url)}`, "loading");
      try {
        const data = await fetchLog(url);
        loaded.push({ url, data });
      } catch (error) {
        errors.push({ url, message: error?.message || "Unknown error" });
      }
    }

    els.analyze.disabled = false;
    els.demo.disabled = false;
    state.logs = loaded;
    showErrors(errors);

    if (!loaded.length) {
      setStatus("None of the reports could be loaded. Check the links and try again.");
      return;
    }

    renderAll();
    setStatus(`Loaded ${loaded.length} of ${urls.length} report${urls.length === 1 ? "" : "s"}. Judgment complete.`, "success");
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function demoLog(name, success, players, mechanics = []) {
    return {
      fightName: name,
      success,
      durationMS: 248000,
      mechanics,
      players: players.map((p) => ({
        name: p.name,
        account: p.account,
        profession: p.profession,
        dpsAll: [{ dps: p.dps, damage: p.dps * 240, breakbarDamage: p.cc }],
        activeTimes: [240000],
        defenses: [{ deadCount: p.deaths, downCount: p.downs, downDuration: p.downs * 3200, damageTaken: p.taken, dodgeCount: p.dodges || 0 }],
        support: [{ resurrects: p.res || 0, resurrectTime: (p.res || 0) * 1800, condiCleanse: p.cleanse || 0, boonStrips: p.strips || 0 }],
        statsAll: [{ distToCom: p.dist, skillCastUptime: p.cast, wasted: p.wasted || 0 }],
      })),
    };
  }

  function loadDemo() {
    const squad = [
      { name: "Definitely A Healer", account: "Medic.1234", profession: "Druid", dps: 6500, cc: 640, deaths: 0, downs: 1, taken: 490000, res: 6, cleanse: 48, dist: 112, cast: 72, wasted: 2 },
      { name: "Red Circle Enjoyer", account: "Oops.7777", profession: "Virtuoso", dps: 28700, cc: 410, deaths: 3, downs: 5, taken: 1250000, res: 0, cleanse: 1, dist: 314, cast: 83, wasted: 7 },
      { name: "Bonk Department", account: "Hammer.5555", profession: "Scrapper", dps: 22100, cc: 2780, deaths: 1, downs: 1, taken: 870000, res: 2, cleanse: 19, dist: 96, cast: 88, wasted: 1 },
      { name: "Parse Goblin", account: "Greed.9001", profession: "Soulbeast", dps: 35100, cc: 120, deaths: 1, downs: 2, taken: 760000, res: 0, cleanse: 0, dist: 246, cast: 91, wasted: 3 },
      { name: "Tag Attachment", account: "Stack.2468", profession: "Chronomancer", dps: 15600, cc: 920, deaths: 0, downs: 0, taken: 510000, res: 1, cleanse: 14, strips: 23, dist: 54, cast: 79, wasted: 1 },
    ];

    const mechanics = [
      { name: "Red Circle", severity: "Sev2", mechanicsData: [{ actor: "Red Circle Enjoyer", weight: 1 }, { actor: "Red Circle Enjoyer", weight: 1 }, { actor: "Parse Goblin", weight: 1 }] },
      { name: "Big Slam", severity: "Sev3", mechanicsData: [{ actor: "Red Circle Enjoyer", weight: 1 }, { actor: "Bonk Department", weight: 1 }] },
    ];

    state.logs = [
      { url: "https://dps.report/demo-1_boss", data: demoLog("Vale Guardian", true, squad, mechanics) },
      { url: "https://dps.report/demo-2_boss", data: demoLog("Gorseval", false, squad.map((p) => ({ ...p, deaths: p.deaths + (p.name === "Red Circle Enjoyer" ? 2 : 0), downs: p.downs + 1 })), mechanics) },
      { url: "https://dps.report/demo-3_boss", data: demoLog("Sabetha", true, squad, mechanics) },
    ];
    els.errors.innerHTML = "";
    renderAll();
    setStatus("Demo raid night loaded. No actual guildmates were harmed.", "success");
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearAll() {
    els.input.value = "";
    els.errors.innerHTML = "";
    els.results.hidden = true;
    state.logs = [];
    state.players = [];
    state.awards = [];
    setStatus("");
  }

  async function copySummary() {
    if (!state.awards.length) return;
    const lines = ["🏆 **GW2 RAID OSCARS**", ""];
    for (const item of state.awards) {
      lines.push(`${item.icon} **${item.title} — ${playerLabel(item.winner)}**`);
      lines.push(`${item.stat} · _${item.roast}_`);
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
  els.includeWipes.addEventListener("change", () => { if (state.logs.length) renderAll(); });
  els.showAccounts.addEventListener("change", () => { if (state.logs.length) renderAll(); });

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
