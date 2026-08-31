"use strict";

// Build on v6, but make wipe deaths/downs reflect the people who actually
// failed first instead of the cleanup after the squad has already called gg.
importScripts("worker-v6.js?v=2");

const V7_WIPE_CAUSAL_LIMIT = 2;
const v7BaseCompactLog = compactLog;

function v7FirstIntervalStart(intervals) {
  let earliest = Infinity;
  if (!Array.isArray(intervals)) return earliest;
  for (const interval of intervals) {
    if (!Array.isArray(interval) || !interval.length) continue;
    const time = Number(interval[0]);
    if (Number.isFinite(time)) earliest = Math.min(earliest, time);
  }
  return earliest;
}

function v7DeathRecapTimes(player) {
  let death = Infinity;
  let down = Infinity;
  const recaps = Array.isArray(player?.deathRecap) ? player.deathRecap : [];

  for (const recap of recaps) {
    const deathTime = Number(recap?.deathTime);
    if (Number.isFinite(deathTime)) death = Math.min(death, deathTime);

    // EI's death recap stores the damage events leading into downstate. The
    // latest of those event times is our fallback when combat replay is absent.
    const toDown = Array.isArray(recap?.toDown) ? recap.toDown : [];
    let recapDown = -Infinity;
    for (const item of toDown) {
      const time = Number(item?.time);
      if (Number.isFinite(time)) recapDown = Math.max(recapDown, time);
    }
    if (Number.isFinite(recapDown)) down = Math.min(down, recapDown);
  }

  return { death, down };
}

function v7FirstStateTimes(player) {
  const replay = player?.combatReplayData || {};
  let down = v7FirstIntervalStart(replay?.down);
  let death = v7FirstIntervalStart(replay?.dead);

  if (!Number.isFinite(down) || !Number.isFinite(death)) {
    const recap = v7DeathRecapTimes(player);
    if (!Number.isFinite(down)) down = recap.down;
    if (!Number.isFinite(death)) death = recap.death;
  }

  return { down, death };
}

function v7EarliestUniqueAccounts(rawPlayers, kind) {
  const earliestByAccount = new Map();

  for (const player of rawPlayers) {
    if (player?.notInSquad || player?.friendlyNPC) continue;
    const account = String(player?.account || player?.name || "Unknown");
    const times = v7FirstStateTimes(player);
    const time = kind === "down" ? times.down : times.death;
    if (!Number.isFinite(time)) continue;

    const previous = earliestByAccount.get(account);
    if (!Number.isFinite(previous) || time < previous) {
      earliestByAccount.set(account, time);
    }
  }

  return [...earliestByAccount.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, V7_WIPE_CAUSAL_LIMIT)
    .map(([account]) => account);
}

compactLog = function v7CompactLog(json, url) {
  const log = v7BaseCompactLog(json, url);
  if (log.success) return log;

  const rawPlayers = Array.isArray(json?.players) ? json.players : [];
  const firstDowns = new Set(v7EarliestUniqueAccounts(rawPlayers, "down"));
  const firstDeaths = new Set(v7EarliestUniqueAccounts(rawPlayers, "death"));

  // If EI does not expose timing data for a particular state, keep the old
  // aggregate rather than guessing an order from squad/list order.
  const haveDownOrder = firstDowns.size > 0;
  const haveDeathOrder = firstDeaths.size > 0;

  for (const player of log.players || []) {
    if (haveDownOrder) player.downs = firstDowns.has(player.account) ? 1 : 0;
    if (haveDeathOrder) player.deaths = firstDeaths.has(player.account) ? 1 : 0;
  }

  log.wipeCausalDownAccounts = [...firstDowns];
  log.wipeCausalDeathAccounts = [...firstDeaths];
  return log;
};
