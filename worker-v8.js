"use strict";

// Build on v7, but use Elite Insights' explicit generic Downed/Dead mechanic
// events as the primary timing source. Combat replay/death recap remain only
// as v7 fallbacks when those status mechanics are absent.
importScripts("worker-v7.js?v=2");

const V8_WIPE_CAUSAL_LIMIT = 2;
const v8BaseCompactLog = compactLog;

function v8NormalizeStatusName(value) {
  return String(value || "").trim().toLowerCase();
}

function v8StatusMechanicMatches(mechanic, kind) {
  const wanted = kind === "down" ? "downed" : "dead";
  return [mechanic?.name, mechanic?.fullName]
    .map(v8NormalizeStatusName)
    .some((name) => name === wanted);
}

function v8CharacterToAccount(rawPlayers) {
  const map = new Map();
  for (const player of rawPlayers) {
    if (player?.notInSquad || player?.friendlyNPC) continue;
    const account = String(player?.account || player?.name || "Unknown");
    const name = String(player?.name || account);
    map.set(name, account);
  }
  return map;
}

function v8EarliestAccountsFromMechanics(json, kind) {
  const rawPlayers = Array.isArray(json?.players) ? json.players : [];
  const characterToAccount = v8CharacterToAccount(rawPlayers);
  const earliestByAccount = new Map();

  for (const mechanic of Array.isArray(json?.mechanics) ? json.mechanics : []) {
    if (!v8StatusMechanicMatches(mechanic, kind)) continue;

    for (const event of Array.isArray(mechanic?.mechanicsData) ? mechanic.mechanicsData : []) {
      const actor = String(event?.actor || "");
      const account = characterToAccount.get(actor);
      const time = Number(event?.time);
      if (!account || !Number.isFinite(time)) continue;

      const previous = earliestByAccount.get(account);
      if (!Number.isFinite(previous) || time < previous) {
        earliestByAccount.set(account, time);
      }
    }
  }

  return [...earliestByAccount.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, V8_WIPE_CAUSAL_LIMIT)
    .map(([account, time]) => ({ account, time }));
}

compactLog = function v8CompactLog(json, url) {
  const log = v8BaseCompactLog(json, url);
  if (log.success) return log;

  const exactDowns = v8EarliestAccountsFromMechanics(json, "down");
  const exactDeaths = v8EarliestAccountsFromMechanics(json, "death");

  // Only overwrite v7's fallback result when the explicit status mechanics are
  // actually present. This avoids inventing ordering if a report lacks them.
  if (exactDowns.length) {
    const counted = new Set(exactDowns.map((item) => item.account));
    for (const player of log.players || []) {
      player.downs = counted.has(player.account) ? 1 : 0;
    }
    log.wipeCausalDownAccounts = [...counted];
    log.wipeDownTimingSource = "mechanics";
  }

  if (exactDeaths.length) {
    const counted = new Set(exactDeaths.map((item) => item.account));
    for (const player of log.players || []) {
      player.deaths = counted.has(player.account) ? 1 : 0;
    }
    log.wipeCausalDeathAccounts = [...counted];
    log.wipeDeathTimingSource = "mechanics";
  }

  return log;
};
