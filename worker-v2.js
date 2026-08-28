"use strict";

const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30000;
const QUICKNESS_ID = 1187;
const ALACRITY_ID = 30328;
// Elite Insights boon generation is percentage-like. Anything below this is treated
// as incidental rather than a real boon-support assignment.
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

let cachedLogs = [];
let cachedErrors = [];

function n(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function first(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function reportPath(url) {
  try { return new URL(url).pathname.slice(1); } catch { return url; }
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
    .replace(/\s*\((?:player\s+)?(?:hit by|damage from|dmg from|stood in|failed)?[^)]*\)\s*$/i, "")
    .trim();
  return cleaned || short || full;
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

function compactLog(json, url) {
  const rawPlayers = Array.isArray(json?.players) ? json.players : [];
  const byAccount = new Map();
  const characterToAccount = new Map();

  for (const p of rawPlayers) {
    if (p?.notInSquad || p?.friendlyNPC) continue;
    const account = String(p?.account || p?.name || "Unknown");
    const name = String(p?.name || account);
    characterToAccount.set(name, account);

    const dps = first(p?.dpsAll) || {};
    const defense = first(p?.defenses) || {};
    const support = first(p?.support) || {};
    const stats = first(p?.statsAll) || {};
    const activeMs = n(first(p?.activeTimes), 0);
    const quicknessGeneration = boonGeneration(p, QUICKNESS_ID);
    const alacrityGeneration = boonGeneration(p, ALACRITY_ID);

    let cp = byAccount.get(account);
    if (!cp) {
      cp = {
        account,
        name,
        profession: p?.profession || "Unknown",
        activeMs: 0,
        damage: 0,
        fallbackDpsSum: 0,
        fallbackDpsCount: 0,
        breakbar: 0,
        deaths: 0,
        downs: 0,
        downDuration: 0,
        damageTaken: 0,
        dodges: 0,
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
        mechanicNames: {},
        quicknessGenerationMax: 0,
        alacrityGenerationMax: 0,
        providesQuickness: false,
        providesAlacrity: false,
        boonProvider: false,
      };
      byAccount.set(account, cp);
    }

    cp.profession = p?.profession || cp.profession;
    cp.activeMs += activeMs;
    cp.damage += n(dps.damage);
    if (n(dps.dps) > 0) {
      cp.fallbackDpsSum += n(dps.dps);
      cp.fallbackDpsCount += 1;
    }
    cp.breakbar += n(dps.breakbarDamage);
    cp.deaths += n(defense.deadCount);
    cp.downs += n(defense.downCount);
    cp.downDuration += n(defense.downDuration);
    cp.damageTaken += n(defense.damageTaken);
    cp.dodges += n(defense.dodgeCount);
    cp.resurrects += n(support.resurrects);
    cp.resurrectTime += n(support.resurrectTime);
    cp.cleanses += n(support.condiCleanse);
    cp.boonStrips += n(support.boonStrips);
    cp.wastedCasts += n(stats.wasted);
    cp.quicknessGenerationMax = Math.max(cp.quicknessGenerationMax, quicknessGeneration);
    cp.alacrityGenerationMax = Math.max(cp.alacrityGenerationMax, alacrityGeneration);

    const weight = activeMs > 0 ? activeMs : Math.max(1, n(json?.durationMS, 1));
    const cast = Number(stats.skillCastUptime);
    if (Number.isFinite(cast) && cast >= 0) {
      cp.castUptimeWeighted += cast * weight;
      cp.castUptimeWeight += weight;
    }
    const distance = Number(stats.distToCom);
    if (Number.isFinite(distance) && distance >= 0) {
      cp.distanceWeighted += distance * weight;
      cp.distanceWeight += weight;
    }
  }

  for (const cp of byAccount.values()) {
    cp.providesQuickness = cp.quicknessGenerationMax >= BOON_PROVIDER_THRESHOLD;
    cp.providesAlacrity = cp.alacrityGenerationMax >= BOON_PROVIDER_THRESHOLD;
    cp.boonProvider = cp.providesQuickness || cp.providesAlacrity;
  }

  for (const mechanic of Array.isArray(json?.mechanics) ? json.mechanics : []) {
    if (!usefulMechanic(mechanic)) continue;
    const sev = String(mechanic?.severity || "Sev1");
    const sevWeight = severityWeight[sev] ?? 1;
    const name = friendlyMechanicName(mechanic);
    const minGap = Math.max(750, n(mechanic?.internalCooldown, 1250));
    const lastByActor = new Map();

    for (const event of Array.isArray(mechanic?.mechanicsData) ? mechanic.mechanicsData : []) {
      const actorName = String(event?.actor || "");
      const account = characterToAccount.get(actorName);
      if (!account) continue;
      const cp = byAccount.get(account);
      if (!cp) continue;

      const time = Number(event?.time);
      if (Number.isFinite(time)) {
        const previous = lastByActor.get(actorName);
        if (Number.isFinite(previous) && time - previous < minGap) continue;
        lastByActor.set(actorName, time);
      }

      const eventWeight = Math.max(0.1, n(event?.weight, 1));
      cp.mechanicEvents += 1;
      cp.mechanicScore += sevWeight * eventWeight;
      cp.mechanicNames[name] = (cp.mechanicNames[name] || 0) + 1;
    }
  }

  const phase = first(json?.phases);
  const target = first(json?.targets);
  const fightName = json?.fightName || json?.encounterName || phase?.name || target?.name || "Unknown encounter";

  return {
    url,
    fightName,
    success: json?.success === true,
    durationMS: n(json?.durationMS),
    playerCount: byAccount.size,
    players: [...byAccount.values()],
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

async function fetchLog(url) {
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
      return compactLog(json, url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not load report");
}

function emptyAggregate(p) {
  return {
    account: p.account,
    displayName: p.name || p.account,
    profession: p.profession || "Unknown",
    characters: [p.name || p.account],
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
    damageTakenPerMin: 0,
    dodges: 0,
    breakbar: 0,
    breakbarPerLog: 0,
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
    mechanicScorePerLog: 0,
    mechanicEvents: 0,
    mechanicNames: {},
    quicknessProviderLogs: 0,
    alacrityProviderLogs: 0,
    boonProviderLogs: 0,
    quicknessGenerationMax: 0,
    alacrityGenerationMax: 0,
    providesQuickness: false,
    providesAlacrity: false,
    boonProvider: false,
    dps: 0,
    distance: 0,
    castUptime: 0,
  };
}

function aggregate(logs, includeWipes) {
  const included = logs.filter((log) => includeWipes || log.success);
  const map = new Map();

  for (const log of included) {
    for (const p of log.players) {
      let a = map.get(p.account);
      if (!a) {
        a = emptyAggregate(p);
        map.set(p.account, a);
      }

      a.profession = p.profession || a.profession;
      if (p.name && !a.characters.includes(p.name)) a.characters.push(p.name);
      a.encounters += 1;
      if (log.success) a.successes += 1; else a.wipes += 1;
      a.activeMs += p.activeMs;
      a.totalDamage += p.damage;
      a.fallbackDpsSum += p.fallbackDpsSum;
      a.fallbackDpsCount += p.fallbackDpsCount;
      a.deaths += p.deaths;
      a.downs += p.downs;
      a.downDuration += p.downDuration;
      a.damageTaken += p.damageTaken;
      a.dodges += p.dodges;
      a.breakbar += p.breakbar;
      a.resurrects += p.resurrects;
      a.resurrectTime += p.resurrectTime;
      a.cleanses += p.cleanses;
      a.boonStrips += p.boonStrips;
      a.wastedCasts += p.wastedCasts;
      a.castUptimeWeighted += p.castUptimeWeighted;
      a.castUptimeWeight += p.castUptimeWeight;
      a.distanceWeighted += p.distanceWeighted;
      a.distanceWeight += p.distanceWeight;
      a.mechanicScore += p.mechanicScore;
      a.mechanicEvents += p.mechanicEvents;
      a.quicknessGenerationMax = Math.max(a.quicknessGenerationMax, n(p.quicknessGenerationMax));
      a.alacrityGenerationMax = Math.max(a.alacrityGenerationMax, n(p.alacrityGenerationMax));
      if (p.providesQuickness) a.quicknessProviderLogs += 1;
      if (p.providesAlacrity) a.alacrityProviderLogs += 1;
      if (p.boonProvider) a.boonProviderLogs += 1;

      for (const [name, count] of Object.entries(p.mechanicNames || {})) {
        a.mechanicNames[name] = (a.mechanicNames[name] || 0) + count;
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
    p.damageTakenPerMin = p.activeMs ? p.damageTaken / (p.activeMs / 60000) : 0;
    p.breakbarPerLog = p.encounters ? p.breakbar / p.encounters : 0;
    p.mechanicScorePerLog = p.encounters ? p.mechanicScore / p.encounters : 0;
    p.providesQuickness = p.quicknessProviderLogs > 0;
    p.providesAlacrity = p.alacrityProviderLogs > 0;
    p.boonProvider = p.boonProviderLogs > 0;
  }

  return {
    players,
    logs: included.map((log) => ({
      url: log.url,
      fightName: log.fightName,
      success: log.success,
      durationMS: log.durationMS,
      playerCount: log.playerCount,
    })),
  };
}

function top(players, key, predicate = () => true) {
  return players.filter(predicate).sort((a, b) => n(b[key]) - n(a[key]))[0] || null;
}

function bottom(players, key, predicate = () => true) {
  return players.filter(predicate).sort((a, b) => n(a[key]) - n(b[key]))[0] || null;
}

function award(id, icon, title, winner, stat, roast, featured = false) {
  return { id, icon, title, winner, stat, roast, featured };
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return `${Math.round(value)} ${Math.round(value) === 1 ? singular : pluralForm}`;
}

function specificRoast(name) {
  const lower = name.toLowerCase();
  if (/bomb/.test(lower)) return "The phrase ‘take the bomb away from the group’ remains under peer review.";
  if (/cannon/.test(lower)) return "The cannon and this player have developed a recurring professional relationship.";
  if (/oil/.test(lower)) return "A remarkable commitment to workplace incidents involving oil.";
  if (/green/.test(lower)) return "Green circles: still somehow a complicated social contract.";
  if (/teleport|port/.test(lower)) return "Frequent flyer status has officially been unlocked.";
  if (/knock|launch|fear/.test(lower)) return "Their position on the arena was apparently only a draft proposal.";
  if (/orb/.test(lower)) return "They appear to be completing an orb collection achievement nobody else received.";
  if (/slam|smash|shockwave/.test(lower)) return "Saw the large attack and decided first-hand experience was important.";
  if (/fixat/.test(lower)) return "The mechanic chose them repeatedly. At some point this becomes a relationship.";
  return "Once is an accident. At this frequency, the mechanic may start charging rent.";
}

function buildAwards(players) {
  if (!players.length) return [];
  const awards = [];
  const maxAttendance = Math.max(...players.map((p) => p.encounters), 1);
  const regular = (p) => p.encounters >= Math.max(2, Math.ceil(maxAttendance * 0.5));

  const floor = top(players, "deaths", (p) => p.deaths > 0);
  if (floor) awards.push(award(
    "floor", "💀", "Floor Inspector", floor,
    `${plural(floor.deaths, "death")} across ${plural(floor.encounters, "log")}`,
    "Most deaths in the submitted raid night. Nobody studied the arena texture pack more thoroughly.", true
  ));

  const downs = top(players, "downs", (p) => p.downs > 0);
  if (downs) awards.push(award(
    "downstate", "🛌", "Downstate Connoisseur", downs,
    `${plural(downs.downs, "down")} across ${plural(downs.encounters, "log")}`,
    "Spent more time than anyone else sampling Guild Wars 2's alternate horizontal combat stance."
  ));

  const dps = top(players, "dps", (p) => regular(p) && p.dps > 0);
  if (dps) awards.push(award(
    "dps", "🔥", "DPS Goblin", dps,
    `${Math.round(dps.dps).toLocaleString()} weighted DPS over ${plural(dps.encounters, "log")}`,
    "Highest damage rate among regular attendees. The boss health bars were treated as a personal grievance."
  ));

  const lowPureDps = bottom(players, "dps", (p) => regular(p) && p.dps > 0 && !p.boonProvider);
  if (lowPureDps) awards.push(award(
    "low-pure-dps", "📉", "Support Excuse Denied", lowPureDps,
    `${Math.round(lowPureDps.dps).toLocaleString()} weighted DPS over ${plural(lowPureDps.encounters, "log")} · no meaningful Quickness/Alacrity generation`,
    "Lowest damage rate among regular attendees who did not meaningfully provide Quickness or Alacrity. The ‘I was boon support’ defense has been formally denied."
  ));

  const cc = top(players, "breakbarPerLog", (p) => regular(p) && p.breakbar > 0);
  if (cc) awards.push(award(
    "cc", "🔨", "Bonk Enthusiast", cc,
    `${Math.round(cc.breakbarPerLog).toLocaleString()} breakbar damage per log`,
    "Best average blue-bar violence among regular attendees. When CC was requested, they actually located the button."
  ));

  const res = top(players, "resurrects", (p) => p.resurrects > 0);
  if (res) awards.push(award(
    "res", "🚑", "Ambulance", res,
    plural(res.resurrects, "resurrection"),
    "Performed the most squad resurrections. Several guildmates remain legally alive because of this person."
  ));

  const cleanse = top(players, "cleanses", (p) => p.cleanses > 0);
  if (cleanse) awards.push(award(
    "cleanse", "🧹", "Condition Janitor", cleanse,
    `${Math.round(cleanse.cleanses).toLocaleString()} cleanses`,
    "Removed more conditions than anyone else. The squad kept making a mess; they kept showing up with the mop."
  ));

  const strips = top(players, "boonStrips", (p) => p.boonStrips > 0);
  if (strips) awards.push(award(
    "strip", "🫳", "Boon Repo Agent", strips,
    `${Math.round(strips.boonStrips).toLocaleString()} boon strips`,
    "Repossessed the most enemy boons. Apparently none of those buffs had completed their payment plan."
  ));

  const sponge = top(players, "damageTakenPerMin", (p) => regular(p) && p.damageTakenPerMin > 0);
  if (sponge) awards.push(award(
    "sponge", "🧽", "Damage Sponge", sponge,
    `${Math.round(sponge.damageTakenPerMin).toLocaleString()} damage taken/min`,
    "Highest incoming damage rate among regular attendees. Dodge rolls were replaced by empirical verification."
  ));

  const orbit = top(players, "distance", (p) => regular(p) && p.distanceWeight > 0 && p.distance > 0);
  if (orbit) awards.push(award(
    "orbit", "🛰️", "Independent Contractor", orbit,
    `${orbit.distance.toFixed(1)} average distance from commander`,
    "Farthest average distance from the tag. Technically in the squad; spiritually operating as a separate business."
  ));

  const pet = bottom(players, "distance", (p) => regular(p) && p.distanceWeight > 0 && p.distance > 0);
  if (pet && (!orbit || pet.account !== orbit.account)) awards.push(award(
    "pet", "🐥", "Commander's Emotional Support", pet,
    `${pet.distance.toFixed(1)} average distance from commander`,
    "Closest average distance to the tag. If the commander moved three pixels, they had already moved four."
  ));

  const buttons = top(players, "castUptime", (p) => regular(p) && p.castUptime > 0);
  if (buttons) awards.push(award(
    "buttons", "⌨️", "Button Presser", buttons,
    `${buttons.castUptime.toFixed(1)}% cast uptime`,
    "Highest time spent actively casting among regular attendees. No keybind was allowed to feel neglected."
  ));

  const wasted = top(players, "wastedCasts", (p) => p.wastedCasts > 0);
  if (wasted) awards.push(award(
    "wasted", "🫠", "Changed My Mind Mid-Cast", wasted,
    plural(wasted.wastedCasts, "interrupted cast"),
    "Started the cast, reflected on the cast, and decided it no longer represented them as a person."
  ));

  const magnet = top(players, "mechanicScorePerLog", (p) => regular(p) && p.mechanicEvents > 0);
  if (magnet) awards.push(award(
    "mechanics", "🎯", "Mechanic Magnet", magnet,
    `${magnet.mechanicScorePerLog.toFixed(1)} filtered mechanic score/log · ${plural(magnet.mechanicEvents, "event")}`,
    "Highest meaningful mechanic-failure rate after removing Sev0 noise, informational entries and rapid repeat ticks."
  ));

  let specific = null;
  for (const p of players) {
    for (const [name, count] of Object.entries(p.mechanicNames || {})) {
      if (count < 2) continue;
      const candidate = { player: p, name, count, rate: count / Math.max(1, p.encounters) };
      if (!specific || candidate.count > specific.count || (candidate.count === specific.count && candidate.rate > specific.rate)) {
        specific = candidate;
      }
    }
  }
  if (specific) awards.push(award(
    "specific", "📌", "Repeat Customer", specific.player,
    `${specific.name} · ${plural(specific.count, "appearance")}`,
    specificRoast(specific.name)
  ));

  const survivor = [...players]
    .filter((p) => p.encounters >= Math.max(2, Math.ceil(maxAttendance * 0.7)))
    .sort((a, b) => a.deaths - b.deaths || b.encounters - a.encounters || b.dps - a.dps)[0];
  if (survivor && survivor.deaths === 0) awards.push(award(
    "survivor", "🪳", "Unreasonably Alive", survivor,
    `0 deaths across ${plural(survivor.encounters, "log")}`,
    "Attended most of the night and declined every opportunity to become part of the scenery."
  ));

  return awards.slice(0, 14);
}

function calculate(includeWipes) {
  const result = aggregate(cachedLogs, includeWipes);
  return { ...result, awards: buildAwards(result.players), errors: cachedErrors };
}

async function loadAll(urls, includeWipes) {
  cachedLogs = [];
  cachedErrors = [];
  let nextIndex = 0;
  let done = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      const url = urls[index];

      try {
        const log = await fetchLog(url);
        cachedLogs.push(log);
      } catch (error) {
        cachedErrors.push({
          url,
          message: error?.name === "AbortError" ? "Timed out" : (error?.message || "Unknown error"),
        });
      } finally {
        done += 1;
        self.postMessage({
          type: "progress",
          done,
          total: urls.length,
          loaded: cachedLogs.length,
          failed: cachedErrors.length,
          current: reportPath(url),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => runner()));
  self.postMessage({ type: "result", ...calculate(includeWipes) });
}

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === "analyze") {
    loadAll(Array.isArray(msg.urls) ? msg.urls : [], Boolean(msg.includeWipes)).catch((error) => {
      self.postMessage({ type: "fatal", message: error?.message || "Worker failed" });
    });
    return;
  }

  if (msg.type === "recalculate") {
    try {
      self.postMessage({ type: "result", ...calculate(Boolean(msg.includeWipes)), recalc: true });
    } catch (error) {
      self.postMessage({ type: "fatal", message: error?.message || "Could not recalculate" });
    }
    return;
  }

  if (msg.type === "reset") {
    cachedLogs = [];
    cachedErrors = [];
  }
};