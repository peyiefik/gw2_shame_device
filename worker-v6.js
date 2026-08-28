"use strict";

// Build on v5's parser, outlier review, and award logic, then add manual
// per-log boon-provider assignment controls.
importScripts("worker-v5.js?v=2");

let v6ProviderSelections = new Map();

function v6ProviderKey(url, boon, account) {
  return `${boon}|${account}|${url}`;
}

function v6Generation(player, boon) {
  return boon === "Quickness"
    ? n(player.quicknessGenerationMax)
    : n(player.alacrityGenerationMax);
}

function v6Coverage(player, boon) {
  return boon === "Quickness"
    ? n(player.quicknessCoverage)
    : n(player.alacrityCoverage);
}

function v6ProviderScore(player, boon) {
  // Keep generation as the dominant assignment signal. Coverage only breaks
  // close calls so a high-uptime subgroup does not manufacture a provider.
  return v6Generation(player, boon) * 0.85 + v6Coverage(player, boon) * 0.15;
}

function v6Candidates(log, boon) {
  return (log.players || []).filter((p) => v6Generation(p, boon) >= BOON_PROVIDER_THRESHOLD);
}

function v6DefaultChosen(log, boon) {
  const candidates = v6Candidates(log, boon);
  const chosen = new Set();
  const groups = new Map();

  for (const p of candidates) {
    const group = n(p.group, 0);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(p);
  }

  const meaningfulGroups = [...groups.keys()].filter((g) => g > 0);
  if (meaningfulGroups.length) {
    for (const group of meaningfulGroups) {
      const ranked = groups.get(group)
        .slice()
        .sort((a, b) => v6ProviderScore(b, boon) - v6ProviderScore(a, boon));
      if (ranked[0]) chosen.add(ranked[0].account);
    }

    const noGroup = (groups.get(0) || [])
      .slice()
      .sort((a, b) => v6ProviderScore(b, boon) - v6ProviderScore(a, boon))
      .slice(0, 2);
    for (const p of noGroup) chosen.add(p.account);
  } else {
    for (const p of candidates
      .slice()
      .sort((a, b) => v6ProviderScore(b, boon) - v6ProviderScore(a, boon))
      .slice(0, 2)) {
      chosen.add(p.account);
    }
  }

  return { candidates, chosen };
}

function v6AssignmentIsAmbiguous(log, quick, alac) {
  const all = [...quick.candidates, ...alac.candidates];
  const uniqueAccounts = new Set(all.map((p) => p.account));
  if (uniqueAccounts.size > 4) return true;

  const crowded = (items) => {
    const groups = new Map();
    for (const p of items) {
      const group = n(p.group, 0);
      groups.set(group, (groups.get(group) || 0) + 1);
    }
    return [...groups.values()].some((count) => count > 1);
  };

  return crowded(quick.candidates) || crowded(alac.candidates);
}

function v6IsSelected(url, boon, account, defaultSelected) {
  const key = v6ProviderKey(url, boon, account);
  return v6ProviderSelections.has(key)
    ? Boolean(v6ProviderSelections.get(key))
    : Boolean(defaultSelected);
}

function v6CandidateView(log, boon, p, chosen) {
  const key = v6ProviderKey(log.url, boon, p.account);
  return {
    key,
    account: p.account,
    displayName: p.name || p.account,
    profession: p.profession || "Unknown",
    group: n(p.group, 0),
    generation: v6Generation(p, boon),
    coverage: v6Coverage(p, boon),
    inferred: chosen.has(p.account),
    selected: v6IsSelected(log.url, boon, p.account, chosen.has(p.account)),
  };
}

function v6BuildAssignment(log) {
  const quick = v6DefaultChosen(log, "Quickness");
  const alac = v6DefaultChosen(log, "Alacrity");
  if (!v6AssignmentIsAmbiguous(log, quick, alac)) return null;

  const quickness = quick.candidates
    .map((p) => v6CandidateView(log, "Quickness", p, quick.chosen))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || a.group - b.group || b.generation - a.generation);
  const alacrity = alac.candidates
    .map((p) => v6CandidateView(log, "Alacrity", p, alac.chosen))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || a.group - b.group || b.generation - a.generation);

  return {
    url: log.url,
    fightName: log.fightName,
    candidateCount: new Set([...quickness, ...alacrity].map((p) => p.account)).size,
    quickness,
    alacrity,
    selectedCount: quickness.filter((p) => p.selected).length + alacrity.filter((p) => p.selected).length,
    totalRoleCandidates: quickness.length + alacrity.length,
  };
}

function v6ApplyProviderAssignments() {
  for (const log of cachedLogs) {
    const assignment = v6BuildAssignment(log);
    if (!assignment) continue;

    const quickSelected = new Set(assignment.quickness.filter((p) => p.selected).map((p) => p.account));
    const alacSelected = new Set(assignment.alacrity.filter((p) => p.selected).map((p) => p.account));
    const quickCandidates = new Set(assignment.quickness.map((p) => p.account));
    const alacCandidates = new Set(assignment.alacrity.map((p) => p.account));

    for (const p of log.players || []) {
      // For ambiguous logs, every candidate is explicitly controlled by the
      // assignment checkbox. Non-candidates cannot be counted as providers.
      p.providesQuickness = quickCandidates.has(p.account) && quickSelected.has(p.account);
      p.providesAlacrity = alacCandidates.has(p.account) && alacSelected.has(p.account);
      p.boonProvider = p.providesQuickness || p.providesAlacrity;
    }
  }
}

function v6Calculate(includeWipes) {
  v6ApplyProviderAssignments();

  const result = aggregate(cachedLogs, includeWipes);
  const points = v5CollectPoints(cachedLogs, includeWipes);
  v5ApplyPointSelection(result.players, points);
  const awards = buildAwards(result.players);
  v5PatchSupportAwards(awards, result.players);

  const boonAssignments = cachedLogs
    .filter((log) => includeWipes || log.success)
    .map((log) => v6BuildAssignment(log))
    .filter(Boolean);

  return {
    ...result,
    awards,
    errors: cachedErrors,
    reviewPoints: v5DetectOutliers(points),
    boonAssignments,
  };
}

async function v6LoadAll(urls, includeWipes) {
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
        // v5's estimator still gives us its original default assignment behavior,
        // but v6 reconstructs every candidate from raw generation so rejected
        // candidates remain available for manual ticking.
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
  self.postMessage({ type: "result", ...v6Calculate(includeWipes) });
}

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === "analyze") {
    v5ExcludedPointKeys = new Set();
    v6ProviderSelections = new Map();
    v6LoadAll(Array.isArray(msg.urls) ? msg.urls : [], Boolean(msg.includeWipes)).catch((error) => {
      self.postMessage({ type: "fatal", message: error?.message || "Worker failed" });
    });
    return;
  }

  if (msg.type === "recalculate") {
    if (Array.isArray(msg.excludedPointKeys)) {
      v5ExcludedPointKeys = new Set(msg.excludedPointKeys);
    }
    if (Array.isArray(msg.providerSelections)) {
      v6ProviderSelections = new Map(
        msg.providerSelections
          .filter((item) => item && typeof item.key === "string")
          .map((item) => [item.key, Boolean(item.selected)])
      );
    }

    try {
      self.postMessage({
        type: "result",
        ...v6Calculate(Boolean(msg.includeWipes)),
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
    v6ProviderSelections = new Map();
  }
};