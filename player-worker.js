"use strict";

const CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 30000;
const QUICKNESS_ID = 1187;
const ALACRITY_ID = 30328;
const BOON_PROVIDER_THRESHOLD = 5;
const severityWeight = { Sev0: 0, Sev1: 1, Sev2: 2, Sev3: 4, Sev4: 7 };

const noisyMechanics = [
  /^floor\s+[rbg]$/i,
  /^attune\s+[rbg]$/i,
  /^green cast\s+[rbg]$/i,
  /^cced(?:\.|$)/i,
  /^cc\.[a-z0-9]+$/i,
  /invuln(?:erability)?\s+strip/i,
  /pylon attunement/i,
  /red floor dmg|blue floor dmg|green floor dmg/i,
  /stood in green/i,
  /breakbar broken/i,
  /green field appeared/i,
  /achievement eligibility/i,
];
const sev1FailureWords = /(fail|failed|hit by|killed|downed|knock|launch|fear|stun|bomb|oil|flak|cannon|shockwave|teleport|port|sacrifice|fixat|poison|corrupt|black|orb|mine|trap|slam|smash|shock|agony|vomit|green|bad|damage)/i;

function n(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function first(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function reportPath(url) {
  try { return new URL(url).pathname.slice(1); } catch { return String(url || ""); }
}

function effectiveGeneration(data) {
  if (!data) return 0;
  return Math.max(0, n(data.generation) + n(data.byExtension) + n(data.extended));
}

function boonGeneration(player, buffId) {
  const collections = [
    player?.groupBuffsActive,
    player?.groupBuffs,
    player?.squadBuffsActive,
    player?.squadBuffs,
  ];
  let best = 0;
  for (const entries of collections) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (n(entry?.id, -1) !== buffId) continue;
      best = Math.max(best, effectiveGeneration(first(entry?.buffData)));
    }
  }
  return best;
}

function boonUptime(player, buffId) {
  const collections = [player?.buffUptimesActive, player?.buffUptimes];
  for (const entries of collections) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (n(entry?.id, -1) !== buffId) continue;
      const value = Number(first(entry?.buffData)?.uptime);
      return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
    }
  }
  return null;
}

function subgroupCoverage(players, provider, uptimeKey, durationMS) {
  const recipients = players.filter((member) =>
    member.group === provider.group &&
    member.account !== provider.account &&
    Number.isFinite(Number(member[uptimeKey]))
  );
  const fallback = recipients.length ? recipients : players.filter((member) =>
    member.group === provider.group && Number.isFinite(Number(member[uptimeKey]))
  );
  let weighted = 0;
  let weight = 0;
  for (const member of fallback) {
    const w = member.activeMs > 0 ? member.activeMs : Math.max(1, n(durationMS, 1));
    weighted += n(member[uptimeKey]) * w;
    weight += w;
  }
  return { uptime: weight > 0 ? weighted / weight : null, weight, recipients: fallback.length };
}

function healingStats(player) {
  const ext = player?.extHealingStats || player?.EXTHealingStats;
  const out = first(ext?.outgoingHealing) || {};
  return {
    hps: n(out.hps ?? out.Hps),
    healing: n(out.healing ?? out.Healing),
    healingPowerHps: n(out.healingPowerHps ?? out.HealingPowerHps),
    healingPowerHealing: n(out.healingPowerHealing ?? out.HealingPowerHealing),
  };
}

function weaponNames(player) {
  const names = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text || /^(unknown|2hand)$/i.test(text)) return;
    names.push(text);
  };

  if (Array.isArray(player?.weaponSets)) {
    for (const set of player.weaponSets) {
      for (const weapon of Array.isArray(set?.weapons) ? set.weapons : []) add(weapon);
    }
  }
  if (!names.length) {
    for (const weapon of Array.isArray(player?.weapons) ? player.weapons : []) add(weapon);
  }
  return [...new Set(names)];
}

function mechanicText(m) {
  return [m?.name, m?.fullName, m?.description].filter(Boolean).join(" · ");
}

function usefulMechanic(m) {
  const severity = String(m?.severity || "Sev0");
  const text = mechanicText(m);
  if (severity === "Sev0") return false;
  if (noisyMechanics.some((pattern) => pattern.test(text))) return false;
  if (severity === "Sev1" && !sev1FailureWords.test(text)) return false;
  return true;
}

function friendlyMechanicName(m) {
  const full = String(m?.fullName || "").trim();
  const short = String(m?.name || "").trim();
  if (!full) return short || "Unknown mechanic";
  const cleaned = full
    .replace(/\s*\((?:player\s+)?(?:hit by|damage from|dmg from|stood in|failed)[^)]*\)\s*$/i, "")
    .trim();
  return cleaned || short || full;
}

function statusRankMaps(json, characterToAccount) {
  const build = (wanted) => {
    const firstByAccount = new Map();
    for (const mechanic of Array.isArray(json?.mechanics) ? json.mechanics : []) {
      const names = [mechanic?.name, mechanic?.fullName].map((x) => String(x || "").trim().toLowerCase());
      if (!names.includes(wanted)) continue;
      for (const event of Array.isArray(mechanic?.mechanicsData) ? mechanic.mechanicsData : []) {
        const account = characterToAccount.get(String(event?.actor || ""));
        const time = Number(event?.time);
        if (!account || !Number.isFinite(time)) continue;
        const prev = firstByAccount.get(account);
        if (!Number.isFinite(prev) || time < prev) firstByAccount.set(account, time);
      }
    }
    const rankMap = new Map();
    [...firstByAccount.entries()]
      .sort((a, b) => a[1] - b[1])
      .forEach(([account, time], index) => rankMap.set(account, { rank: index + 1, time }));
    return rankMap;
  };
  return { down: build("downed"), death: build("dead") };
}

function roleGuess(player) {
  const healSignal = Math.max(n(player.hps), n(player.healingPowerHps));
  if (healSignal >= 1200) return "healer";
  if (player.quicknessGeneration >= BOON_PROVIDER_THRESHOLD || player.alacrityGeneration >= BOON_PROVIDER_THRESHOLD) return "boondps";
  return "dps";
}

function boonGuess(player) {
  const q = player.quicknessGeneration >= BOON_PROVIDER_THRESHOLD;
  const a = player.alacrityGeneration >= BOON_PROVIDER_THRESHOLD;
  if (q && a) return "both";
  if (q) return "quickness";
  if (a) return "alacrity";
  return "none";
}

function compactLog(json, url, index) {
  const rawPlayers = Array.isArray(json?.players) ? json.players : [];
  const characterToAccount = new Map();
  const byAccount = new Map();

  for (const p of rawPlayers) {
    if (p?.notInSquad || p?.friendlyNPC) continue;
    const account = String(p?.account || p?.name || "Unknown");
    const name = String(p?.name || account);
    characterToAccount.set(name, account);

    const dps = first(p?.dpsAll) || {};
    const defense = first(p?.defenses) || {};
    const support = first(p?.support) || {};
    const stats = first(p?.statsAll) || {};
    const activeMs = n(first(p?.activeTimes));
    const heal = healingStats(p);

    const current = {
      account,
      name,
      profession: String(p?.profession || "Unknown"),
      group: n(p?.group),
      activeMs,
      damage: n(dps.damage),
      dps: n(dps.dps),
      activeDps: activeMs > 0 ? n(dps.damage) / (activeMs / 1000) : n(dps.dps),
      breakbar: n(dps.breakbarDamage),
      deaths: n(defense.deadCount),
      downs: n(defense.downCount),
      downDuration: n(defense.downDuration),
      damageTaken: n(defense.damageTaken),
      damageTakenPerMin: activeMs > 0 ? n(defense.damageTaken) / (activeMs / 60000) : 0,
      dodges: n(defense.dodgeCount),
      resurrects: n(support.resurrects),
      resurrectTime: n(support.resurrectTime),
      cleanses: n(support.condiCleanse),
      boonStrips: n(support.boonStrips),
      wastedCasts: n(stats.wasted),
      castUptime: n(stats.skillCastUptime),
      commanderDistance: n(stats.distToCom),
      quicknessGeneration: boonGeneration(p, QUICKNESS_ID),
      alacrityGeneration: boonGeneration(p, ALACRITY_ID),
      quicknessSelfUptime: boonUptime(p, QUICKNESS_ID),
      alacritySelfUptime: boonUptime(p, ALACRITY_ID),
      quicknessCoverage: null,
      alacrityCoverage: null,
      hps: heal.hps,
      healing: heal.healing,
      healingPowerHps: heal.healingPowerHps,
      healingPowerHealing: heal.healingPowerHealing,
      weapons: weaponNames(p),
      mechanicScore: 0,
      mechanicEvents: 0,
      mechanics: {},
      firstDownRank: null,
      firstDownTime: null,
      firstDeathRank: null,
      firstDeathTime: null,
    };

    const existing = byAccount.get(account);
    if (!existing) {
      byAccount.set(account, current);
    } else {
      existing.name = current.name || existing.name;
      existing.profession = current.profession || existing.profession;
      existing.group = current.group || existing.group;
      existing.activeMs += current.activeMs;
      existing.damage += current.damage;
      existing.dps = existing.activeMs > 0 ? existing.damage / (existing.activeMs / 1000) : Math.max(existing.dps, current.dps);
      existing.activeDps = existing.dps;
      for (const key of ["breakbar", "deaths", "downs", "downDuration", "damageTaken", "dodges", "resurrects", "resurrectTime", "cleanses", "boonStrips", "wastedCasts", "healing"]) existing[key] += current[key];
      existing.damageTakenPerMin = existing.activeMs > 0 ? existing.damageTaken / (existing.activeMs / 60000) : 0;
      existing.quicknessGeneration = Math.max(existing.quicknessGeneration, current.quicknessGeneration);
      existing.alacrityGeneration = Math.max(existing.alacrityGeneration, current.alacrityGeneration);
      existing.quicknessSelfUptime = current.quicknessSelfUptime ?? existing.quicknessSelfUptime;
      existing.alacritySelfUptime = current.alacritySelfUptime ?? existing.alacritySelfUptime;
      existing.hps = Math.max(existing.hps, current.hps);
      existing.healingPowerHps = Math.max(existing.healingPowerHps, current.healingPowerHps);
      existing.weapons = [...new Set([...existing.weapons, ...current.weapons])];
      existing.castUptime = Math.max(existing.castUptime, current.castUptime);
      existing.commanderDistance = current.commanderDistance || existing.commanderDistance;
    }
  }

  const players = [...byAccount.values()];
  for (const p of players) {
    if (p.quicknessGeneration >= BOON_PROVIDER_THRESHOLD) {
      p.quicknessCoverage = subgroupCoverage(players, p, "quicknessSelfUptime", json?.durationMS).uptime;
    }
    if (p.alacrityGeneration >= BOON_PROVIDER_THRESHOLD) {
      p.alacrityCoverage = subgroupCoverage(players, p, "alacritySelfUptime", json?.durationMS).uptime;
    }
  }

  for (const mechanic of Array.isArray(json?.mechanics) ? json.mechanics : []) {
    if (!usefulMechanic(mechanic)) continue;
    const sev = String(mechanic?.severity || "Sev1");
    const baseWeight = severityWeight[sev] ?? 1;
    const name = friendlyMechanicName(mechanic);
    const minGap = Math.max(750, n(mechanic?.internalCooldown, 1250));
    const lastByActor = new Map();

    for (const event of Array.isArray(mechanic?.mechanicsData) ? mechanic.mechanicsData : []) {
      const actor = String(event?.actor || "");
      const account = characterToAccount.get(actor);
      const p = byAccount.get(account);
      if (!p) continue;
      const time = Number(event?.time);
      if (Number.isFinite(time)) {
        const prev = lastByActor.get(actor);
        if (Number.isFinite(prev) && time - prev < minGap) continue;
        lastByActor.set(actor, time);
      }
      const eventWeight = Math.max(0.1, n(event?.weight, 1));
      p.mechanicEvents += 1;
      p.mechanicScore += baseWeight * eventWeight;
      p.mechanics[name] = (p.mechanics[name] || 0) + 1;
    }
  }

  const ranks = statusRankMaps(json, characterToAccount);
  for (const p of players) {
    const down = ranks.down.get(p.account);
    const death = ranks.death.get(p.account);
    if (down) {
      p.firstDownRank = down.rank;
      p.firstDownTime = down.time;
    }
    if (death) {
      p.firstDeathRank = death.rank;
      p.firstDeathTime = death.time;
    }
    p.roleGuess = roleGuess(p);
    p.boonGuess = boonGuess(p);
  }

  const dpsValues = players.map((p) => p.dps).filter((x) => x > 0);
  const phase = first(json?.phases);
  const target = first(json?.targets);

  return {
    index,
    url,
    reportPath: reportPath(url),
    fightName: String(json?.fightName || json?.encounterName || phase?.name || target?.name || "Unknown encounter"),
    success: json?.success === true,
    durationMS: n(json?.durationMS),
    timeStart: String(json?.timeStartStd || json?.timeStart || ""),
    squadMedianDps: median(dpsValues),
    squadTopDps: dpsValues.length ? Math.max(...dpsValues) : 0,
    players,
  };
}

async function fetchJsonWithTimeout(requestUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(requestUrl, { method: "GET", mode: "cors", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLog(url, index) {
  const preferBackup = /https?:\/\/b\.dps\.report\//i.test(url);
  const endpoints = preferBackup
    ? ["https://b.dps.report/getJson", "https://dps.report/getJson"]
    : ["https://dps.report/getJson", "https://b.dps.report/getJson"];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const requestUrl = `${endpoint}?permalink=${encodeURIComponent(url)}`;
      const json = await fetchJsonWithTimeout(requestUrl);
      if (!json || !Array.isArray(json.players)) throw new Error("No Elite Insights player data");
      return compactLog(json, url, index);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not load report");
}

function buildRoster(logs) {
  const map = new Map();
  for (const log of logs) {
    for (const p of log.players || []) {
      let r = map.get(p.account);
      if (!r) {
        r = { account: p.account, names: new Set(), professions: new Set(), pulls: 0 };
        map.set(p.account, r);
      }
      r.names.add(p.name);
      r.professions.add(p.profession);
      r.pulls += 1;
    }
  }
  return [...map.values()]
    .map((r) => ({ account: r.account, names: [...r.names], professions: [...r.professions], pulls: r.pulls }))
    .sort((a, b) => b.pulls - a.pulls || a.account.localeCompare(b.account));
}

async function analyze(urls) {
  const results = new Array(urls.length);
  const errors = [];
  let nextIndex = 0;
  let done = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      const url = urls[index];
      try {
        results[index] = await fetchLog(url, index);
      } catch (error) {
        errors.push({ url, message: error?.name === "AbortError" ? "Timed out" : (error?.message || "Unknown error") });
      } finally {
        done += 1;
        self.postMessage({ type: "progress", done, total: urls.length, loaded: results.filter(Boolean).length, failed: errors.length, current: reportPath(url) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => runner()));
  const logs = results.filter(Boolean);
  self.postMessage({ type: "result", logs, roster: buildRoster(logs), errors });
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== "analyze") return;
  analyze(Array.isArray(msg.urls) ? msg.urls : []).catch((error) => {
    self.postMessage({ type: "fatal", message: error?.message || "Player analysis failed" });
  });
};
