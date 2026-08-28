"use strict";

// Build on the stable v3 parser/aggregator, then add reviewable support-uptime datapoints.
importScripts("worker-v3.js?v=2");

const OUTLIER_MIN_POINTS = 3;
const OUTLIER_GAP_PP = 12;
const OUTLIER_ISOLATION_PP = 7;

const v3Aggregate = aggregate;
const v3BuildAwards = buildAwards;
let excludedSupportKeys = new Set();

function supportPointKey(account, boon, url) {
  return `${boon}|${account}|${url}`;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function collectSupportPoints(logs, includeWipes) {
  const points = [];
  const included = logs.filter((log) => includeWipes || log.success);

  for (const log of included) {
    for (const p of log.players || []) {
      if (p.providesQuickness && p.quicknessCoverage !== null && p.quicknessCoverageWeight > 0) {
        points.push({
          key: supportPointKey(p.account, "Quickness", log.url),
          account: p.account,
          displayName: p.name || p.account,
          profession: p.profession || "Unknown",
          boon: "Quickness",
          uptime: n(p.quicknessCoverage),
          weight: n(p.quicknessCoverageWeight),
          url: log.url,
          fightName: log.fightName,
          success: log.success,
        });
      }

      if (p.providesAlacrity && p.alacrityCoverage !== null && p.alacrityCoverageWeight > 0) {
        points.push({
          key: supportPointKey(p.account, "Alacrity", log.url),
          account: p.account,
          displayName: p.name || p.account,
          profession: p.profession || "Unknown",
          boon: "Alacrity",
          uptime: n(p.alacrityCoverage),
          weight: n(p.alacrityCoverageWeight),
          url: log.url,
          fightName: log.fightName,
          success: log.success,
        });
      }
    }
  }

  return points;
}

function applySupportPointSelection(players, points) {
  const byAccount = new Map(players.map((p) => [p.account, p]));

  for (const p of players) {
    p.quicknessCoverageWeighted = 0;
    p.quicknessCoverageWeight = 0;
    p.quicknessUptime = 0;
    p.quicknessUptimeLogs = 0;
    p.alacrityCoverageWeighted = 0;
    p.alacrityCoverageWeight = 0;
    p.alacrityUptime = 0;
    p.alacrityUptimeLogs = 0;
  }

  for (const point of points) {
    if (excludedSupportKeys.has(point.key)) continue;
    const p = byAccount.get(point.account);
    if (!p) continue;

    if (point.boon === "Quickness") {
      p.quicknessCoverageWeighted += point.uptime * point.weight;
      p.quicknessCoverageWeight += point.weight;
      p.quicknessUptimeLogs += 1;
    } else if (point.boon === "Alacrity") {
      p.alacrityCoverageWeighted += point.uptime * point.weight;
      p.alacrityCoverageWeight += point.weight;
      p.alacrityUptimeLogs += 1;
    }
  }

  for (const p of players) {
    p.quicknessUptime = p.quicknessCoverageWeight > 0
      ? p.quicknessCoverageWeighted / p.quicknessCoverageWeight
      : 0;
    p.alacrityUptime = p.alacrityCoverageWeight > 0
      ? p.alacrityCoverageWeighted / p.alacrityCoverageWeight
      : 0;
  }
}

function providerAverage(providers, uptimeKey, weightKey) {
  let total = 0;
  let weight = 0;
  for (const p of providers) {
    const w = n(p[weightKey]);
    if (w <= 0) continue;
    total += n(p[uptimeKey]) * w;
    weight += w;
  }
  return weight > 0 ? total / weight : 0;
}

function patchSupportAwards(awards, players) {
  const quickProviders = players.filter((p) => p.quicknessProviderLogs > 0 && p.quicknessCoverageWeight > 0);
  const worstQuick = quickProviders.slice().sort((a, b) => a.quicknessUptime - b.quicknessUptime)[0];
  const quickAward = awards.find((a) => a.id === "quickness-uptime");
  if (quickAward && worstQuick) {
    const avg = providerAverage(quickProviders, "quicknessUptime", "quicknessCoverageWeight");
    const gap = Math.max(0, avg - worstQuick.quicknessUptime);
    quickAward.stat = `${worstQuick.quicknessUptime.toFixed(1)}% average subgroup Quickness · provider average ${avg.toFixed(1)}% · ${plural(worstQuick.quicknessUptimeLogs, "included Quickness log")}`;
    quickAward.roast = `Lowest included Quickness uptime among detected providers${gap >= 0.1 ? ` — ${gap.toFixed(1)} percentage points below the provider average.` : "."}`;
  }

  const alacProviders = players.filter((p) => p.alacrityProviderLogs > 0 && p.alacrityCoverageWeight > 0);
  const worstAlac = alacProviders.slice().sort((a, b) => a.alacrityUptime - b.alacrityUptime)[0];
  const alacAward = awards.find((a) => a.id === "alacrity-uptime");
  if (alacAward && worstAlac) {
    const avg = providerAverage(alacProviders, "alacrityUptime", "alacrityCoverageWeight");
    const gap = Math.max(0, avg - worstAlac.alacrityUptime);
    alacAward.stat = `${worstAlac.alacrityUptime.toFixed(1)}% average subgroup Alacrity · provider average ${avg.toFixed(1)}% · ${plural(worstAlac.alacrityUptimeLogs, "included Alacrity log")}`;
    alacAward.roast = `Lowest included Alacrity uptime among detected providers${gap >= 0.1 ? ` — ${gap.toFixed(1)} percentage points below the provider average.` : "."}`;
  }
}

function detectSupportOutliers(points) {
  const groups = new Map();
  for (const point of points) {
    const id = `${point.account}|${point.boon}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(point);
  }

  const outliers = [];
  for (const group of groups.values()) {
    if (group.length < OUTLIER_MIN_POINTS) continue;

    const sorted = group.slice().sort((a, b) => a.uptime - b.uptime);
    const lowest = sorted[0];
    const second = sorted[1];
    const usual = median(sorted.slice(1).map((p) => p.uptime));
    const gap = usual - lowest.uptime;
    const isolation = second.uptime - lowest.uptime;

    if (gap < OUTLIER_GAP_PP || isolation < OUTLIER_ISOLATION_PP) continue;

    outliers.push({
      ...lowest,
      usual,
      gap,
      sampleCount: group.length,
      excluded: excludedSupportKeys.has(lowest.key),
    });
  }

  return outliers.sort((a, b) => b.gap - a.gap);
}

function calculateV4(includeWipes) {
  const result = v3Aggregate(cachedLogs, includeWipes);
  const supportPoints = collectSupportPoints(cachedLogs, includeWipes);
  applySupportPointSelection(result.players, supportPoints);

  const awards = v3BuildAwards(result.players);
  patchSupportAwards(awards, result.players);

  return {
    ...result,
    awards,
    errors: cachedErrors,
    supportOutliers: detectSupportOutliers(supportPoints),
  };
}

// v3 loadAll() resolves calculate() at runtime, so replace it with the v4 calculation.
calculate = calculateV4;

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === "analyze") {
    excludedSupportKeys = new Set();
    loadAll(Array.isArray(msg.urls) ? msg.urls : [], Boolean(msg.includeWipes)).catch((error) => {
      self.postMessage({ type: "fatal", message: error?.message || "Worker failed" });
    });
    return;
  }

  if (msg.type === "recalculate") {
    if (Array.isArray(msg.excludedSupportKeys)) {
      excludedSupportKeys = new Set(msg.excludedSupportKeys);
    }
    try {
      self.postMessage({
        type: "result",
        ...calculateV4(Boolean(msg.includeWipes)),
        recalc: true,
      });
    } catch (error) {
      self.postMessage({ type: "fatal", message: error?.message || "Could not recalculate" });
    }
    return;
  }

  if (msg.type === "reset") {
    cachedLogs = [];
    cachedErrors = [];
    excludedSupportKeys = new Set();
  }
};
