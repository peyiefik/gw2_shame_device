(() => {
  "use strict";

  const els = {
    input: document.getElementById("player-report-input"),
    analyze: document.getElementById("player-analyze-button"),
    status: document.getElementById("player-status"),
    errors: document.getElementById("player-errors"),
    results: document.getElementById("player-results"),
    select: document.getElementById("player-select"),
    title: document.getElementById("player-title"),
    subtitle: document.getElementById("player-subtitle"),
    summary: document.getElementById("player-summary"),
    specs: document.getElementById("spec-breakdown-body"),
    pulls: document.getElementById("pull-table-body"),
    roleFilters: document.getElementById("role-switch-filters"),
    strengths: document.getElementById("strength-list"),
    weaknesses: document.getElementById("weakness-list"),
    weapons: document.getElementById("weapon-summary"),
    mechanics: document.getElementById("mechanic-summary"),
    trend: document.getElementById("damage-trend"),
    roleButtons: [...document.querySelectorAll("[data-role-choice]")],
    boonButtons: [...document.querySelectorAll("[data-boon-choice]")],
    includeAll: document.getElementById("include-all-pulls"),
    excludeWipes: document.getElementById("exclude-wipes"),
  };

  const state = {
    worker: null,
    logs: [],
    roster: [],
    errors: [],
    account: "",
    role: "dps",
    boon: "none",
    excludedUrls: new Set(),
    queryAccount: new URLSearchParams(location.search).get("account") || "",
    queryName: new URLSearchParams(location.search).get("name") || "",
  };

  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const one = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

  function n(value, fallback = 0) {
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

  function parseUrls(raw) {
    const out = [];
    const seen = new Set();
    for (let item of String(raw || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
      if (!/^https?:\/\//i.test(item)) item = `https://${item}`;
      try {
        const u = new URL(item);
        if (!["dps.report", "www.dps.report", "b.dps.report"].includes(u.hostname.toLowerCase())) continue;
        if (!u.pathname || u.pathname === "/") continue;
        const normalized = `https://${u.hostname.toLowerCase() === "www.dps.report" ? "dps.report" : u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
        if (!seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
      } catch {}
    }
    return out;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function average(values) {
    const good = values.filter(Number.isFinite);
    return good.length ? good.reduce((a, b) => a + b, 0) / good.length : 0;
  }

  function duration(ms) {
    const total = Math.max(0, Math.round(n(ms) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function roleLabel(role) {
    return role === "boondps" ? "Boon DPS" : role === "healer" ? "Healer" : "DPS";
  }

  function boonLabel(boon) {
    return boon === "quickness" ? "Quickness" : boon === "alacrity" ? "Alacrity" : boon === "both" ? "Quickness + Alacrity" : "No boon";
  }

  function setStatus(text, kind = "") {
    els.status.textContent = text;
    els.status.className = `status ${kind}`.trim();
  }

  function currentRows(includeExcluded = false) {
    return state.logs
      .map((log) => {
        const p = (log.players || []).find((x) => x.account === state.account);
        return p ? { log, p, signature: `${p.profession} · ${roleLabel(p.roleGuess)}${p.boonGuess !== "none" ? ` · ${boonLabel(p.boonGuess)}` : ""}` } : null;
      })
      .filter(Boolean)
      .filter((row) => includeExcluded || !state.excludedUrls.has(row.log.url));
  }

  function inferTopRole(rows) {
    if (!rows.length) return { role: "dps", boon: "none" };
    const roleCounts = new Map();
    const boonCounts = new Map();
    for (const { p } of rows) {
      roleCounts.set(p.roleGuess, (roleCounts.get(p.roleGuess) || 0) + 1);
      boonCounts.set(p.boonGuess, (boonCounts.get(p.boonGuess) || 0) + 1);
    }
    const role = [...roleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "dps";
    const boon = [...boonCounts.entries()].filter(([k]) => k !== "both").sort((a, b) => b[1] - a[1])[0]?.[0] || "none";
    return { role, boon };
  }

  function applyChoiceButtons() {
    for (const button of els.roleButtons) button.classList.toggle("active", button.dataset.roleChoice === state.role);
    for (const button of els.boonButtons) button.classList.toggle("active", button.dataset.boonChoice === state.boon);
  }

  function renderRoster() {
    els.select.innerHTML = state.roster.map((r) => {
      const names = r.names.length ? ` — ${r.names.join(", ")}` : "";
      return `<option value="${escapeHtml(r.account)}">${escapeHtml(r.account)}${escapeHtml(names)} · ${r.pulls} pulls</option>`;
    }).join("");
    if (state.account) els.select.value = state.account;
  }

  function renderSummary(rows) {
    const pulls = rows.length;
    const kills = rows.filter(({ log }) => log.success).length;
    const dps = rows.map(({ p }) => n(p.dps));
    const hps = rows.map(({ p }) => n(p.hps)).filter((x) => x > 0);
    const firstDowns = rows.filter(({ p }) => p.firstDownRank === 1).length;
    const firstDeaths = rows.filter(({ p }) => p.firstDeathRank === 1).length;
    const totalDowns = rows.reduce((s, { p }) => s + n(p.downs), 0);
    const totalDeaths = rows.reduce((s, { p }) => s + n(p.deaths), 0);
    const avgDps = average(dps);
    const medDps = median(dps);
    const best = rows.slice().sort((a, b) => n(b.p.dps) - n(a.p.dps))[0];
    const boonValues = state.boon === "quickness"
      ? rows.map(({ p }) => p.quicknessCoverage).filter(Number.isFinite)
      : state.boon === "alacrity"
        ? rows.map(({ p }) => p.alacrityCoverage).filter(Number.isFinite)
        : [];

    const cards = [
      [pulls, "included pulls"],
      [`${kills}/${pulls}`, "kills"],
      [fmt.format(avgDps), "average DPS"],
      [fmt.format(medDps), "median DPS"],
      [best ? fmt.format(best.p.dps) : "—", best ? `best · ${best.log.fightName}` : "best DPS"],
      [`${firstDowns} / ${firstDeaths}`, "1st down / 1st death"],
      [`${totalDowns} / ${totalDeaths}`, "downs / deaths"],
    ];
    if (boonValues.length) cards.push([`${one.format(average(boonValues))}%`, `${boonLabel(state.boon)} subgroup uptime`]);
    if (hps.length) cards.push([fmt.format(average(hps)), "average HPS (EXT)"]);

    els.summary.innerHTML = cards.map(([value, label]) => `<div class="summary-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  }

  function renderRoleSwitches(allRows) {
    const groups = new Map();
    for (const row of allRows) {
      if (!groups.has(row.signature)) groups.set(row.signature, []);
      groups.get(row.signature).push(row);
    }
    els.roleFilters.innerHTML = [...groups.entries()].map(([signature, rows]) => {
      const included = rows.filter((r) => !state.excludedUrls.has(r.log.url)).length;
      const checked = included === rows.length;
      const indeterminate = included > 0 && included < rows.length;
      const urls = rows.map((r) => r.log.url).join("\n");
      return `<label class="role-switch-chip">
        <input class="signature-toggle" type="checkbox" ${checked ? "checked" : ""} data-indeterminate="${indeterminate ? "1" : "0"}" data-urls="${escapeHtml(urls)}" />
        <span><strong>${escapeHtml(signature)}</strong><small>${included}/${rows.length} included</small></span>
      </label>`;
    }).join("");
    els.roleFilters.querySelectorAll(".signature-toggle").forEach((input) => { input.indeterminate = input.dataset.indeterminate === "1"; });
  }

  function summarizeWeapons(rows) {
    const counts = new Map();
    for (const { p } of rows) for (const weapon of p.weapons || []) counts.set(weapon, (counts.get(weapon) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    els.weapons.innerHTML = sorted.length
      ? sorted.map(([name, count]) => `<span class="data-pill"><strong>${escapeHtml(name)}</strong> ${count} pull${count === 1 ? "" : "s"}</span>`).join("")
      : `<span class="muted-note">No weapon data exposed in these reports.</span>`;
  }

  function summarizeMechanics(rows) {
    const counts = new Map();
    for (const { p } of rows) for (const [name, count] of Object.entries(p.mechanics || {})) counts.set(name, (counts.get(name) || 0) + n(count));
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    els.mechanics.innerHTML = sorted.length
      ? sorted.map(([name, count]) => `<span class="data-pill bad"><strong>${escapeHtml(name)}</strong> ×${count}</span>`).join("")
      : `<span class="muted-note">No repeated filtered mechanic failures.</span>`;
  }

  function renderSpecs(rows) {
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.p.profession)) groups.set(row.p.profession, []);
      groups.get(row.p.profession).push(row);
    }
    els.specs.innerHTML = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([spec, specRows]) => {
      const dps = average(specRows.map(({ p }) => p.dps));
      const hps = average(specRows.map(({ p }) => p.hps).filter((x) => x > 0));
      const q = average(specRows.map(({ p }) => p.quicknessCoverage).filter(Number.isFinite));
      const a = average(specRows.map(({ p }) => p.alacrityCoverage).filter(Number.isFinite));
      const firstDown = specRows.filter(({ p }) => p.firstDownRank === 1).length;
      const firstDeath = specRows.filter(({ p }) => p.firstDeathRank === 1).length;
      const weapons = [...new Set(specRows.flatMap(({ p }) => p.weapons || []))].join(", ") || "—";
      return `<tr>
        <td>${escapeHtml(spec)}</td><td>${specRows.length}</td><td>${fmt.format(dps)}</td><td>${hps ? fmt.format(hps) : "—"}</td>
        <td>${q ? `${one.format(q)}%` : "—"}</td><td>${a ? `${one.format(a)}%` : "—"}</td><td>${firstDown}/${firstDeath}</td><td>${escapeHtml(weapons)}</td>
      </tr>`;
    }).join("");
  }

  function renderTrend(rows) {
    const values = rows.map(({ p }) => n(p.dps));
    if (values.length < 2) {
      els.trend.innerHTML = `<span class="muted-note">Need at least two included pulls for a trend.</span>`;
      return;
    }
    const width = 900;
    const height = 180;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 18 - ((v - min) / span) * (height - 36);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    els.trend.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="DPS trend across included pulls">
      <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${values.map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = height - 18 - ((v - min) / span) * (height - 36);
        return `<circle cx="${x}" cy="${y}" r="5"><title>${fmt.format(v)} DPS</title></circle>`;
      }).join("")}
    </svg><div class="trend-range"><span>${fmt.format(min)}</span><span>${fmt.format(max)} DPS</span></div>`;
  }

  function renderInsights(rows) {
    const good = [];
    const bad = [];
    if (!rows.length) {
      els.strengths.innerHTML = els.weaknesses.innerHTML = `<li>No pulls selected.</li>`;
      return;
    }

    const dps = rows.map(({ p }) => n(p.dps));
    const med = median(dps);
    const best = rows.slice().sort((a, b) => n(b.p.dps) - n(a.p.dps))[0];
    const aboveSquad = rows.filter(({ p, log }) => n(log.squadMedianDps) > 0 && n(p.dps) >= n(log.squadMedianDps) * 1.15).length;
    const belowSquad = rows.filter(({ p, log }) => n(log.squadMedianDps) > 0 && n(p.dps) < n(log.squadMedianDps) * 0.85).length;
    const lowOwn = rows.filter(({ p }) => med > 0 && n(p.dps) < med * 0.8).length;
    const firstDowns = rows.filter(({ p }) => p.firstDownRank === 1).length;
    const firstDeaths = rows.filter(({ p }) => p.firstDeathRank === 1).length;
    const mechanicTotal = rows.reduce((s, { p }) => s + n(p.mechanicScore), 0);

    if (best) good.push(`Best damage pull: ${best.log.fightName} at ${fmt.format(best.p.dps)} DPS.`);
    if (aboveSquad) good.push(`Beat the submitted squad DPS median by at least 15% on ${aboveSquad}/${rows.length} included pulls.`);
    if (!firstDowns && !firstDeaths) good.push(`Never supplied the first down or first death on the included pulls.`);
    if (mechanicTotal / rows.length < 1) good.push(`Filtered mechanic score stayed very low across the selected pulls.`);

    if (belowSquad) bad.push(`Sat at least 15% below the submitted squad DPS median on ${belowSquad}/${rows.length} pulls.`);
    if (lowOwn) bad.push(`${lowOwn} pull${lowOwn === 1 ? " was" : "s were"} more than 20% below this player's own selected-pull median.`);
    if (firstDowns) bad.push(`Was the first player down on ${firstDowns} included pull${firstDowns === 1 ? "" : "s"}.`);
    if (firstDeaths) bad.push(`Was the first player dead on ${firstDeaths} included pull${firstDeaths === 1 ? "" : "s"}.`);

    if (state.role === "boondps" || state.role === "healer") {
      if (state.boon === "quickness" || state.boon === "alacrity") {
        const key = state.boon === "quickness" ? "quicknessCoverage" : "alacrityCoverage";
        const uptimes = rows.map(({ p }) => p[key]).filter(Number.isFinite);
        if (uptimes.length) {
          const avg = average(uptimes);
          const low = uptimes.filter((x) => x < 90).length;
          if (avg >= 95) good.push(`${boonLabel(state.boon)} subgroup uptime averaged ${one.format(avg)}%.`);
          else bad.push(`${boonLabel(state.boon)} subgroup uptime averaged ${one.format(avg)}%; ${low} measured pull${low === 1 ? " was" : "s were"} below 90%.`);
        } else {
          bad.push(`No usable ${boonLabel(state.boon)} subgroup-uptime data on the selected pulls.`);
        }
      }
    }

    if (state.role === "healer") {
      const hps = rows.map(({ p }) => n(p.hps)).filter((x) => x > 0);
      const res = rows.reduce((s, { p }) => s + n(p.resurrects), 0);
      const cleanses = rows.reduce((s, { p }) => s + n(p.cleanses), 0);
      if (hps.length) good.push(`EXT healing data is present: ${fmt.format(average(hps))} average HPS across measured pulls.`);
      else bad.push(`These reports do not contain EXT healing data, so healer output cannot be judged directly.`);
      if (res || cleanses) good.push(`${res} resurrect${res === 1 ? "" : "s"} and ${cleanses} condition cleanses across the included pulls.`);
    }

    if (!good.length) good.push("No strong positive pattern yet — narrow the pull set to one role/spec for a cleaner comparison.");
    if (!bad.length) bad.push("No obvious recurring red flag in the selected pull set.");

    els.strengths.innerHTML = good.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    els.weaknesses.innerHTML = bad.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  }

  function pullTags(row, ownMedian, maxMechanic) {
    const tags = [];
    const { p, log } = row;
    if (n(p.dps) >= ownMedian * 1.15 && ownMedian > 0) tags.push(["good", "high DPS"]);
    if (n(p.dps) < ownMedian * 0.8 && ownMedian > 0) tags.push(["bad", "low DPS"]);
    if (p.firstDownRank === 1) tags.push(["bad", "1st down"]);
    else if (p.firstDownRank === 2) tags.push(["warn", "2nd down"]);
    if (p.firstDeathRank === 1) tags.push(["bad", "1st death"]);
    else if (p.firstDeathRank === 2) tags.push(["warn", "2nd death"]);
    if (maxMechanic > 0 && n(p.mechanicScore) >= maxMechanic * 0.8 && n(p.mechanicScore) >= 3) tags.push(["bad", "mechanics"]);
    if (!log.success) tags.push(["warn", "wipe"]);
    return tags.map(([kind, text]) => `<span class="mini-tag ${kind}">${escapeHtml(text)}</span>`).join(" ");
  }

  function renderPulls(allRows) {
    const includedRows = allRows.filter((r) => !state.excludedUrls.has(r.log.url));
    const ownMedian = median(includedRows.map(({ p }) => n(p.dps)));
    const maxMechanic = Math.max(0, ...includedRows.map(({ p }) => n(p.mechanicScore)));

    els.pulls.innerHTML = allRows.map((row) => {
      const { log, p } = row;
      const included = !state.excludedUrls.has(log.url);
      const boon = state.boon === "quickness" ? p.quicknessCoverage : state.boon === "alacrity" ? p.alacrityCoverage : null;
      const ratio = n(log.squadMedianDps) > 0 ? n(p.dps) / n(log.squadMedianDps) : 0;
      const first = [p.firstDownRank ? `D${p.firstDownRank}` : "", p.firstDeathRank ? `X${p.firstDeathRank}` : ""].filter(Boolean).join(" / ") || "—";
      const weapons = (p.weapons || []).join(", ") || "—";
      const mechanicTop = Object.entries(p.mechanics || {}).sort((a, b) => b[1] - a[1])[0];
      return `<tr class="${included ? "" : "excluded-row"}">
        <td><input class="pull-toggle" type="checkbox" data-url="${escapeHtml(log.url)}" ${included ? "checked" : ""}></td>
        <td><a class="encounter-link" href="${escapeHtml(log.url)}" target="_blank" rel="noopener">${escapeHtml(log.fightName)} ↗</a><div class="pull-tags">${pullTags(row, ownMedian, maxMechanic)}</div></td>
        <td>${log.success ? "Kill" : "Wipe"}<br><span class="muted-note">${duration(log.durationMS)}</span></td>
        <td>${escapeHtml(p.name)}<br><span class="muted-note">${escapeHtml(p.profession)}</span></td>
        <td>${escapeHtml(roleLabel(p.roleGuess))}<br><span class="muted-note">${escapeHtml(boonLabel(p.boonGuess))}</span></td>
        <td class="good-number">${fmt.format(p.dps)}</td>
        <td>${ratio ? `${one.format(ratio * 100)}%` : "—"}</td>
        <td>${boon === null || boon === undefined ? "—" : `${one.format(boon)}%`}</td>
        <td>${p.hps ? fmt.format(p.hps) : "—"}</td>
        <td>${first}</td>
        <td>${p.downs}/${p.deaths}</td>
        <td>${fmt.format(p.damageTakenPerMin)}</td>
        <td>${fmt.format(p.breakbar)}</td>
        <td>${one.format(p.castUptime)}%</td>
        <td>${escapeHtml(weapons)}</td>
        <td>${mechanicTop ? `${escapeHtml(mechanicTop[0])} ×${mechanicTop[1]}` : "—"}</td>
      </tr>`;
    }).join("");
  }

  function renderAll() {
    const allRows = currentRows(true);
    const rows = currentRows(false);
    const roster = state.roster.find((r) => r.account === state.account);
    const names = roster?.names || [];
    els.title.textContent = names[0] || state.account || "Player performance";
    els.subtitle.textContent = `${state.account || ""}${names.length > 1 ? ` · characters: ${names.join(", ")}` : ""}`;
    renderSummary(rows);
    renderRoleSwitches(allRows);
    renderSpecs(rows);
    summarizeWeapons(rows);
    summarizeMechanics(rows);
    renderTrend(rows);
    renderInsights(rows);
    renderPulls(allRows);
    applyChoiceButtons();
    els.results.hidden = false;
  }

  function chooseInitialAccount() {
    if (!state.roster.length) return;
    const exact = state.roster.find((r) => r.account === state.queryAccount);
    const byName = state.roster.find((r) => r.names.some((name) => name.toLowerCase() === state.queryName.toLowerCase()));
    state.account = (exact || byName || state.roster[0]).account;
    const inferred = inferTopRole(currentRows(true));
    state.role = inferred.role;
    state.boon = inferred.boon === "both" ? "quickness" : inferred.boon;
  }

  function installWorker() {
    if (state.worker) state.worker.terminate();
    state.worker = new Worker("player-worker.js?v=1");
    state.worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "progress") {
        setStatus(`Processed ${msg.done}/${msg.total} logs · ${msg.loaded} loaded${msg.failed ? ` · ${msg.failed} failed` : ""} · ${msg.current}`, "loading");
        return;
      }
      if (msg.type === "result") {
        state.logs = Array.isArray(msg.logs) ? msg.logs : [];
        state.roster = Array.isArray(msg.roster) ? msg.roster : [];
        state.errors = Array.isArray(msg.errors) ? msg.errors : [];
        els.errors.innerHTML = state.errors.map((e) => `<div class="error-item"><strong>${escapeHtml(e.url)}</strong><br>${escapeHtml(e.message)}</div>`).join("");
        chooseInitialAccount();
        renderRoster();
        renderAll();
        els.analyze.disabled = false;
        setStatus(`Done: ${state.logs.length} usable logs · ${state.roster.length} players${state.errors.length ? ` · ${state.errors.length} failed` : ""}.`, "success");
        return;
      }
      if (msg.type === "fatal") {
        els.analyze.disabled = false;
        setStatus(`Analysis failed: ${msg.message || "unknown error"}`);
      }
    };
    state.worker.onerror = (event) => {
      els.analyze.disabled = false;
      setStatus(`Analysis worker crashed: ${event.message || "unknown error"}`);
    };
  }

  function analyze() {
    const urls = parseUrls(els.input.value);
    if (!urls.length) {
      setStatus("Paste at least one valid dps.report link.");
      return;
    }
    localStorage.setItem("gw2ShameLastReports", els.input.value);
    state.logs = [];
    state.roster = [];
    state.excludedUrls = new Set();
    els.results.hidden = true;
    els.errors.innerHTML = "";
    els.analyze.disabled = true;
    installWorker();
    setStatus(`Starting ${urls.length} logs in the background…`, "loading");
    state.worker.postMessage({ type: "analyze", urls });
  }

  els.analyze.addEventListener("click", analyze);
  els.select.addEventListener("change", () => {
    state.account = els.select.value;
    state.excludedUrls = new Set();
    const inferred = inferTopRole(currentRows(true));
    state.role = inferred.role;
    state.boon = inferred.boon === "both" ? "quickness" : inferred.boon;
    renderAll();
  });

  for (const button of els.roleButtons) {
    button.addEventListener("click", () => {
      state.role = button.dataset.roleChoice;
      if (state.role === "dps") state.boon = "none";
      renderAll();
    });
  }
  for (const button of els.boonButtons) {
    button.addEventListener("click", () => {
      state.boon = button.dataset.boonChoice;
      renderAll();
    });
  }

  els.roleFilters.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("signature-toggle")) return;
    const urls = String(target.dataset.urls || "").split("\n").filter(Boolean);
    for (const url of urls) {
      if (target.checked) state.excludedUrls.delete(url);
      else state.excludedUrls.add(url);
    }
    renderAll();
  });

  els.pulls.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("pull-toggle")) return;
    const url = target.dataset.url;
    if (!url) return;
    if (target.checked) state.excludedUrls.delete(url);
    else state.excludedUrls.add(url);
    renderAll();
  });

  els.includeAll.addEventListener("click", () => {
    state.excludedUrls = new Set();
    renderAll();
  });

  els.excludeWipes.addEventListener("click", () => {
    for (const row of currentRows(true)) if (!row.log.success) state.excludedUrls.add(row.log.url);
    renderAll();
  });

  const saved = localStorage.getItem("gw2ShameLastReports") || "";
  if (saved) {
    els.input.value = saved;
    setTimeout(analyze, 0);
  }
})();
