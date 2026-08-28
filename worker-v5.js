"use strict";

// Reuse the stable parser/compactor and award catalogue from v3, then layer on
// provider-role estimation and a general review system for isolated datapoints.
importScripts("worker-v3.js?v=3");

const V5_MIN_POINTS = 3;
const V5_MAX_REVIEW_ROWS = 40;
let v5ExcludedPointKeys = new Set();

const V5_METRICS = {
  dps: {
    label: "DPS",
    direction: "both",
    scope: "encounter",
    minGap: 5000,
    minRelativeGap: 0.20,
    minIsolation: 2500,
    minRelativeIsolation: 0.10,
    format: (v) => Math.round(v).toLocaleString(),
  },
  deaths: {
    label: "Deaths",
    direction: "high",
    scope: "encounter",
    minGap: 2,
    minRelativeGap: 0,
    minIsolation: 1,
    minRelativeIsolation: 0,
    minValue: 2,
    format: (v) => `${Math.round(v)}`,
  },
  downs: {
    label: "Downs",
    direction: "high",
    scope: "encounter",
    minGap: 3,
    minRelativeGap: 0,
    minIsolation: 1,
    minRelativeIsolation: 0,
    minValue: 3,
    format: (v) => `${Math.round(v)}`,
  },
  damageTakenPerMin: {
    label: "Damage taken/min",
    direction: "high",
    scope: "encounter",
    minGap: 15000,
    minRelativeGap: 0.35,
    minIsolation: 7500,
    minRelativeIsolation: 0.15,
    format: (v) => Math.round(v).toLocaleString(),
  },
  breakbar: {
    label: "Breakbar damage",
    direction: "high",
    scope: "encounter",
    minGap: 500,
    minRelativeGap: 0.75,
    minIsolation: 250,
    minRelativeIsolation: 0.25,
    format: (v) => Math.round(v).toLocaleString(),
  },
  mechanicScore: {
    label: "Mechanic score",
    direction: "high",
    scope: "encounter",
    minGap: 3,
    minRelativeGap: 0.75,
    minIsolation: 1.5,
    minRelativeIsolation: 0.25,
    minValue: 3,
    format: (v) => v.toFixed(1),
  },
  distance: {
    label: "Commander distance",
    direction: "both",
    scope: "encounter",
    minGap: 75,
    minRelativeGap: 0.35,
    minIsolation: 35,
    minRelativeIsolation: 0.15,
    format: (v) => v.toFixed(1),
  },
  castUptime: {
    label: "Cast uptime",
    direction: "both",
    scope: "encounter",
    minGap: 15,
    minRelativeGap: 0,
    minIsolation: 7,
    minRelativeIsolation: 0,
    format: (v) => `${v.toFixed(1)}%`,
  },
  quicknessUptime: {
    label: "Quickness uptime",
    direction: "low",
    scope: "night",
    minGap: 12,
    minRelativeGap: 0,
    minIsolation: 7,
    minRelativeIsolation: 0,
    format: (v) => `${v.toFixed(1)}%`,
  },
  alacrityUptime: {
    label: "Alacrity uptime",
    direction: "low",
    scope: "night",
    minGap: 12,
    minRelativeGap: 0,
    minIsolation: 7,
    minRelativeIsolation: 0,
    format: (v) => `${v.toFixed(1)}%`,
  },
};

function v5PointKey(account, metric, url) {
  return `${metric}|${account}|${url}`;
}

function v5Median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function v5ProviderScore(player, boon) {
  const gen = boon === "Quickness"
    ? n(player.quicknessGenerationMax)
    : n(player.alacrityGenerationMax);
  const coverage = boon === "Quickness"
    ? n(player.quicknessCoverage)
    : n(player.alacrityCoverage);
  // Generation is the assignment signal; subgroup coverage is only a small tie-breaker.
  return gen * 0.85 + coverage * 0.15;
}

function v5PickRoleProviders(players, boon) {
  const providesKey = boon === "Quickness" ? "providesQuickness" : "providesAlacrity";
  const candidates = players.filter((p) => p[providesKey]);
  const chosen = new Set();
  const groups = new Map();

  for (const p of candidates) {
    const group = n(p.group, 0);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(p);
  }

  // If subgroup information exists, the strongest candidate in each subgroup is
  // the most plausible assigned provider. For missing subgroup info, keep the two
  // strongest candidates as a conservative 10-player raid fallback.
  const meaningfulGroups = [...groups.keys()].filter((g) => g > 0);
  if (meaningfulGroups.length) {
    for (const group of meaningfulGroups) {
      const ranked = groups.get(group).slice().sort((a, b) => v5ProviderScore(b, boon) - v5ProviderScore(a, boon));
      if (ranked[0]) chosen.add(ranked[0].account);
    }
    const noGroup = groups.get(0) || [];
    for (const p of noGroup.slice().sort((a, b) => v5ProviderScore(b, boon) - v5ProviderScore(a, boon)).slice(0, 2)) {
      chosen.add(p.account);
    }
  } else {
    for (const p of candidates.slice().sort((a, b) => v5ProviderScore(b, boon) - v5ProviderScore(a, boon)).slice(0, 2)) {
      chosen.add(p.account);
    }
  }

  return { candidates, chosen };
}

function v5EstimateBoonProviders(log) {
  const allCandidates = log.players.filter((p) => p.providesQuickness || p.providesAlacrity);
  const uniqueCandidateAccounts = new Set(allCandidates.map((p) => p.account));

  const quick = v5PickRoleProviders(log.players, "Quickness");
  const alac = v5PickRoleProviders(log.players, "Alacrity");

  const roleCollision = (() => {
    const byGroup = new Map();
    for (const p of quick.candidates) {
      const key = `Q|${n(p.group, 0)}`;
      byGroup.set(key, (byGroup.get(key) || 0) + 1);
    }
    for (const p of alac.candidates) {
      const key = `A|${n(p.group, 0)}`;
      byGroup.set(key, (byGroup.get(key) || 0) + 1);
    }
    return [...byGroup.values()].some((count) => count > 1);
  })();

  const ambiguous = uniqueCandidateAccounts.size > 4 || roleCollision;
  if (!ambiguous) return null;

  for (const p of log.players) {
    if (p.providesQuickness) p.providesQuickness = quick.chosen.has(p.account);
    if (p.providesAlacrity) p.providesAlacrity = alac.chosen.has(p.account);
    p.boonProvider = p.providesQuickness || p.providesAlacrity;
  }

  const chosenQuick = log.players.filter((p) => p.providesQuickness);
  const chosenAlac = log.players.filter((p) => p.providesAlacrity);
  const rejected = allCandidates.filter((p) => !p.boonProvider);

  return {
    url: log.url,
    fightName: log.fightName,
    candidateCount: uniqueCandidateAccounts.size,
    quickness: chosenQuick.map((p) => ({
      account: p.account,
      displayName: p.name || p.account,
      group: n(p.group, 0),
      generation: n(p.quicknessGenerationMax),
    })),
    alacrity: chosenAlac.map((p) => ({
      account: p.account,
      displayName: p.name || p.account,
      group: n(p.group, 0),
      generation: n(p.alacrityGenerationMax),
    })),
    rejected: rejected.map((p) => ({
      account: p.account,
      displayName: p.name || p.account,
      quicknessGeneration: n(p.quicknessGenerationMax),
      alacrityGeneration: n(p.alacrityGenerationMax),
    })),
  };
}

function v5CollectPoints(logs, includeWipes) {
  const points = [];
  const included = logs.filter((log) => includeWipes || log.success);

  function pushPoint(log, p, metric, value, extra = {}) {
    if (!Number.isFinite(Number(value))) return;
    points.push({
      key: v5PointKey(p.account, metric, log.url),
      account: p.account,
      displayName: p.name || p.account,
      profession: p.profession || "Unknown",
      metric,
      metricLabel: V5_METRICS[metric].label,
      value: Number(value),
      url: log.url,
      fightName: log.fightName,
      success: log.success,
      ...extra,
    });
  }

  for (const log of included) {
    for (const p of log.players || []) {
      const activeSec = n(p.activeMs) / 1000;
      const activeMin = n(p.activeMs) / 60000;
      if (activeSec > 0) pushPoint(log, p, "dps", n(p.damage) / activeSec, { numerator: n(p.damage), denominator: activeSec });
      pushPoint(log, p, "deaths", n(p.deaths));
      pushPoint(log, p, "downs", n(p.downs));
      if (activeMin > 0) pushPoint(log, p, "damageTakenPerMin", n(p.damageTaken) / activeMin, { numerator: n(p.damageTaken), denominator: activeMin });
      pushPoint(log, p, "breakbar", n(p.breakbar));
      pushPoint(log, p, "mechanicScore", n(p.mechanicScore), { mechanicEvents: n(p.mechanicEvents) });
      if (n(p.distanceWeight) > 0) {
        const distance = n(p.distanceWeighted) / n(p.distanceWeight);
        pushPoint(log, p, "distance", distance, { weight: n(p.distanceWeight) });
      }
      if (n(p.castUptimeWeight) > 0) {
        const cast = n(p.castUptimeWeighted) / n(p.castUptimeWeight);
        pushPoint(log, p, "castUptime", cast, { weight: n(p.castUptimeWeight) });
      }
      if (p.providesQuickness && p.quicknessCoverage !== null && n(p.quicknessCoverageWeight) > 0) {
        pushPoint(log, p, "quicknessUptime", n(p.quicknessCoverage), { weight: n(p.quicknessCoverageWeight) });
      }
      if (p.providesAlacrity && p.alacrityCoverage !== null && n(p.alacrityCoverageWeight) > 0) {
        pushPoint(log, p, "alacrityUptime", n(p.alacrityCoverage), { weight: n(p.alacrityCoverageWeight) });
      }
    }
  }

  return points;
}

function v5ApplyPointSelection(players, points) {
  const byAccount = new Map(players.map((p) => [p.account, p]));
  const grouped = new Map();

  for (const point of points) {
    if (v5ExcludedPointKeys.has(point.key)) continue;
    const id = `${point.account}|${point.metric}`;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(point);
  }

  for (const [id, series] of grouped) {
    const split = id.indexOf("|");
    const account = id.slice(0, split);
    const metric = id.slice(split + 1);
    const p = byAccount.get(account);
    if (!p || !series.length) continue;

    if (metric === "dps") {
      const damage = series.reduce((sum, x) => sum + n(x.numerator), 0);
      const seconds = series.reduce((sum, x) => sum + n(x.denominator), 0);
      p.dps = seconds > 0 ? damage / seconds : 0;
    } else if (metric === "deaths") {
      p.deaths = series.reduce((sum, x) => sum + n(x.value), 0);
    } else if (metric === "downs") {
      p.downs = series.reduce((sum, x) => sum + n(x.value), 0);
    } else if (metric === "damageTakenPerMin") {
      const damage = series.reduce((sum, x) => sum + n(x.numerator), 0);
      const minutes = series.reduce((sum, x) => sum + n(x.denominator), 0);
      p.damageTakenPerMin = minutes > 0 ? damage / minutes : 0;
    } else if (metric === "breakbar") {
      p.breakbar = series.reduce((sum, x) => sum + n(x.value), 0);
      p.breakbarPerLog = p.breakbar / series.length;
    } else if (metric === "mechanicScore") {
      p.mechanicScore = series.reduce((sum, x) => sum + n(x.value), 0);
      p.mechanicEvents = series.reduce((sum, x) => sum + n(x.mechanicEvents), 0);
      p.mechanicScorePerLog = p.mechanicScore / series.length;
    } else if (metric === "distance" || metric === "castUptime" || metric === "quicknessUptime" || metric === "alacrityUptime") {
      const weight = series.reduce((sum, x) => sum + Math.max(0, n(x.weight, 1)), 0);
      const weighted = series.reduce((sum, x) => sum + n(x.value) * Math.max(0, n(x.weight, 1)), 0);
      const avg = weight > 0 ? weighted / weight : 0;
      if (metric === "distance") {
        p.distance = avg;
        p.distanceWeight = weight;
      } else if (metric === "castUptime") {
        p.castUptime = avg;
        p.castUptimeWeight = weight;
      } else if (metric === "quicknessUptime") {
        p.quicknessUptime = avg;
        p.quicknessCoverageWeight = weight;
        p.quicknessUptimeLogs = series.length;
      } else {
        p.alacrityUptime = avg;
        p.alacrityCoverageWeight = weight;
        p.alacrityUptimeLogs = series.length;
      }
    }
  }
}

function v5QualifiesOutlier(candidate, usual, isolation, def) {
  const gap = Math.abs(candidate - usual);
  const scale = Math.max(Math.abs(usual), 1);
  if (gap < def.minGap) return false;
  if (def.minRelativeGap && gap / scale < def.minRelativeGap) return false;
  if (isolation < def.minIsolation) return false;
  if (def.minRelativeIsolation && isolation / scale < def.minRelativeIsolation) return false;
  if (def.minValue !== undefined && candidate < def.minValue) return false;
  return true;
}

function v5DetectOutliers(points) {
  const groups = new Map();
  for (const point of points) {
    const def = V5_METRICS[point.metric];
    const scope = def.scope === "encounter" ? point.fightName : "night";
    const id = `${point.account}|${point.metric}|${scope}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(point);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length < V5_MIN_POINTS) continue;
    const metric = group[0].metric;
    const def = V5_METRICS[metric];
    const sorted = group.slice().sort((a, b) => a.value - b.value);

    const examine = (side) => {
      const candidate = side === "low" ? sorted[0] : sorted[sorted.length - 1];
      const neighbor = side === "low" ? sorted[1] : sorted[sorted.length - 2];
      const rest = sorted.filter((p) => p.key !== candidate.key);
      const usual = v5Median(rest.map((p) => p.value));
      const gapSigned = side === "low" ? usual - candidate.value : candidate.value - usual;
      const isolation = side === "low" ? neighbor.value - candidate.value : candidate.value - neighbor.value;
      if (gapSigned <= 0 || !v5QualifiesOutlier(candidate.value, usual, isolation, def)) return;

      const format = def.format;
      out.push({
        ...candidate,
        usual,
        gap: gapSigned,
        direction: side,
        sampleCount: group.length,
        excluded: v5ExcludedPointKeys.has(candidate.key),
        valueText: format(candidate.value),
        usualText: format(usual),
        gapText: `${side === "low" ? "−" : "+"}${format(gapSigned)}`,
        suspicion: gapSigned / Math.max(def.minGap, 1) + isolation / Math.max(def.minIsolation, 1),
      });
    };

    if (def.direction === "low" || def.direction === "both") examine("low");
    if (def.direction === "high" || def.direction === "both") examine("high");
  }

  return out
    .sort((a, b) => b.suspicion - a.suspicion)
    .slice(0, V5_MAX_REVIEW_ROWS);
}

function v5WeightedProviderAverage(providers, uptimeKey, weightKey) {
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

function v5PatchSupportAwards(awards, players) {
  const quickProviders = players.filter((p) => p.quicknessProviderLogs > 0 && p.quicknessCoverageWeight > 0);
  const worstQuick = quickProviders.slice().sort((a, b) => a.quicknessUptime - b.quicknessUptime)[0];
  const quickAward = awards.find((a) => a.id === "quickness-uptime");
  if (quickAward && worstQuick) {
    quickAward.winner = worstQuick;
    const avg = v5WeightedProviderAverage(quickProviders, "quicknessUptime", "quicknessCoverageWeight");
    const gap = Math.max(0, avg - worstQuick.quicknessUptime);
    quickAward.stat = `${worstQuick.quicknessUptime.toFixed(1)}% average subgroup Quickness · provider average ${avg.toFixed(1)}% · ${plural(worstQuick.quicknessUptimeLogs || worstQuick.quicknessProviderLogs, "included Quickness log")}`;
    quickAward.roast = `Lowest included Quickness uptime among estimated providers${gap >= 0.1 ? ` — ${gap.toFixed(1)} percentage points below the provider average.` : "."}`;
  }

  const alacProviders = players.filter((p) => p.alacrityProviderLogs > 0 && p.alacrityCoverageWeight > 0);
  const worstAlac = alacProviders.slice().sort((a, b) => a.alacrityUptime - b.alacrityUptime)[0];
  const alacAward = awards.find((a) => a.id === "alacrity-uptime");
  if (alacAward && worstAlac) {
    alacAward.winner = worstAlac;
    const avg = v5WeightedProviderAverage(alacProviders, "alacrityUptime", "alacrityCoverageWeight");
    const gap = Math.max(0, avg - worstAlac.alacrityUptime);
    alacAward.stat = `${worstAlac.alacrityUptime.toFixed(1)}% average subgroup Alacrity · provider average ${avg.toFixed(1)}% · ${plural(worstAlac.alacrityUptimeLogs || worstAlac.alacrityProviderLogs, "included Alacrity log")}`;
    alacAward.roast = `Lowest included Alacrity uptime among estimated providers${gap >= 0.1 ? ` — ${gap.toFixed(1)} percentage points below the provider average.` : "."}`;
  }
}

function v5Calculate(includeWipes) {
  const result = aggregate(cachedLogs, includeWipes);
  const points = v5CollectPoints(cachedLogs, includeWipes);
  v5ApplyPointSelection(result.players, points);
  const awards = buildAwards(result.players);
  v5PatchSupportAwards(awards, result.players);

  return {
    ...result,
    awards,
    errors: cachedErrors,
    reviewPoints: v5DetectOutliers(points),
    boonEstimates: cachedLogs
      .map((log) => log.v5BoonEstimate)
      .filter(Boolean),
  };
}

async function v5LoadAll(urls, includeWipes) {
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
        log.v5BoonEstimate = v5EstimateBoonProviders(log);
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
  self.postMessage({ type: "result", ...v5Calculate(includeWipes) });
}

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === "analyze") {
    v5ExcludedPointKeys = new Set();
    v5LoadAll(Array.isArray(msg.urls) ? msg.urls : [], Boolean(msg.includeWipes)).catch((error) => {
      self.postMessage({ type: "fatal", message: error?.message || "Worker failed" });
    });
    return;
  }

  if (msg.type === "recalculate") {
    if (Array.isArray(msg.excludedPointKeys)) {
      v5ExcludedPointKeys = new Set(msg.excludedPointKeys);
    }
    try {
      self.postMessage({
        type: "result",
        ...v5Calculate(Boolean(msg.includeWipes)),
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
    v5ExcludedPointKeys = new Set();
  }
};
