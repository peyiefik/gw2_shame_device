(() => {
  "use strict";

  const originalFetch = window.fetch.bind(window);

  const noisy = [
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
  ];

  const sev1FailureWords = /(fail|failed|hit by|killed|downed|knock|launch|fear|stun|bomb|oil|flak|cannon|shockwave|teleport|port|sacrifice|fixat|poison|corrupt|black|orb|mine|trap|slam|smash|shock)/i;

  function first(array) {
    return Array.isArray(array) && array.length ? array[0] : null;
  }

  function mechanicText(m) {
    return [m?.name, m?.fullName, m?.description].filter(Boolean).join(" · ");
  }

  function usefulMechanic(m) {
    const severity = String(m?.severity || "Sev0");
    const text = mechanicText(m);
    if (severity === "Sev0") return false;
    if (noisy.some((pattern) => pattern.test(text))) return false;
    if (severity === "Sev1" && !sev1FailureWords.test(text)) return false;
    return true;
  }

  function friendlyName(m) {
    const full = String(m?.fullName || "").trim();
    const short = String(m?.name || "").trim();
    if (!full) return short || "Unknown mechanic";
    const cleaned = full
      .replace(/\s*\((?:hit by|player hit by|damage from|dmg from)?[^)]*\)\s*$/i, "")
      .trim();
    return cleaned || full || short;
  }

  function collapseRapidRepeats(events, cooldownMs) {
    if (!Array.isArray(events) || events.length < 2) return events || [];
    const minGap = Math.max(750, Number(cooldownMs) || 1250);
    const lastByActor = new Map();
    const result = [];

    for (const event of events) {
      const actor = String(event?.actor || event?.instid || "unknown");
      const time = Number(event?.time);
      if (Number.isFinite(time)) {
        const previous = lastByActor.get(actor);
        if (Number.isFinite(previous) && time - previous < minGap) continue;
        lastByActor.set(actor, time);
      }
      result.push(event);
    }
    return result;
  }

  function compactPlayer(player) {
    const dps = first(player?.dpsAll) || {};
    const defense = first(player?.defenses) || {};
    const support = first(player?.support) || {};
    const stats = first(player?.statsAll) || {};
    const active = first(player?.activeTimes);

    return {
      name: player?.name || "Unknown",
      account: player?.account || player?.name || "Unknown",
      profession: player?.profession || "Unknown",
      notInSquad: Boolean(player?.notInSquad),
      friendlyNPC: Boolean(player?.friendlyNPC),
      dpsAll: [{
        dps: Number(dps.dps) || 0,
        damage: Number(dps.damage) || 0,
        breakbarDamage: Number(dps.breakbarDamage) || 0,
      }],
      activeTimes: [Number(active) || 0],
      defenses: [{
        deadCount: Number(defense.deadCount) || 0,
        downCount: Number(defense.downCount) || 0,
        downDuration: Number(defense.downDuration) || 0,
        damageTaken: Number(defense.damageTaken) || 0,
        dodgeCount: Number(defense.dodgeCount) || 0,
      }],
      support: [{
        resurrects: Number(support.resurrects) || 0,
        resurrectTime: Number(support.resurrectTime) || 0,
        condiCleanse: Number(support.condiCleanse) || 0,
        boonStrips: Number(support.boonStrips) || 0,
      }],
      statsAll: [{
        wasted: Number(stats.wasted) || 0,
        skillCastUptime: Number(stats.skillCastUptime) || 0,
        distToCom: Number.isFinite(Number(stats.distToCom)) ? Number(stats.distToCom) : -1,
      }],
    };
  }

  function compactMechanic(mechanic) {
    if (!usefulMechanic(mechanic)) return null;

    const compactEvents = collapseRapidRepeats(mechanic?.mechanicsData, mechanic?.internalCooldown)
      .map((event) => ({
        actor: event?.actor || null,
        weight: Number(event?.weight) || 1,
      }))
      .filter((event) => event.actor);

    if (!compactEvents.length) return null;

    return {
      name: friendlyName(mechanic),
      severity: mechanic?.severity || "Sev1",
      mechanicsData: compactEvents,
    };
  }

  function compactEliteInsightsJson(json) {
    const firstPhase = first(json?.phases);
    const firstTarget = first(json?.targets);

    return {
      fightName: json?.fightName || json?.encounterName || firstPhase?.name || firstTarget?.name || "Unknown encounter",
      encounterName: json?.encounterName || null,
      success: json?.success === true,
      durationMS: Number(json?.durationMS) || 0,
      phases: firstPhase?.name ? [{ name: firstPhase.name }] : [],
      targets: firstTarget?.name ? [{ name: firstTarget.name }] : [],
      players: Array.isArray(json?.players) ? json.players.map(compactPlayer) : [],
      mechanics: Array.isArray(json?.mechanics)
        ? json.mechanics.map(compactMechanic).filter(Boolean)
        : [],
    };
  }

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    if (!/https:\/\/(?:b\.)?dps\.report\/getJson/i.test(url)) return response;

    try {
      // Parse the response once, keep only the tiny subset Shame Device needs,
      // and let the original response become collectible immediately.
      const json = await response.json();
      const compact = compactEliteInsightsJson(json);
      return new Response(JSON.stringify(compact), {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.warn("Shame Device compaction failed; using original response", error);
      return response;
    }
  };

  const descriptions = {
    "Floor Inspector": "Spent more time reviewing Tyria from ground level than anyone else. A diligent inspection, if nothing else.",
    "Downstate Connoisseur": "A comprehensive practical study of Guild Wars 2's alternate horizontal combat stance.",
    "DPS Goblin": "The boss health bar was treated as a personal grievance, and the numbers support the allegation.",
    "Bonk Enthusiast": "Whenever a blue bar appeared, they responded with the appropriate amount of blunt-force paperwork.",
    "Ambulance": "Single-handedly preventing several guildmates from becoming permanent encounter decoration.",
    "Condition Janitor": "The squad kept collecting conditions. They kept removing them. Nobody learned anything.",
    "Boon Repo Agent": "Those enemy boons were apparently purchased on credit and have now been repossessed.",
    "Damage Sponge": "Why dodge when you can personally verify the boss's tooltip damage? A commitment to empirical science.",
    "Independent Contractor": "Technically in the squad. Spiritually operating under a flexible interpretation of ‘stack on tag.’",
    "Commander's Emotional Support": "If the commander moved three pixels, they were already there waiting.",
    "Button Presser": "No keybind was allowed to spend the evening feeling neglected.",
    "Changed My Mind Mid-Cast": "Started the cast. Considered the cast. Decided it no longer represented who they are as a person.",
    "Mechanic Magnet": "After filtering low-severity and informational Elite Insights noise, this player was still involved in the most suspicious activity.",
    "Unreasonably Alive": "Everyone else was exploring downstate mechanics. They declined the educational opportunity.",
  };

  function specificRoast(title) {
    const name = title.replace(/\s+Specialist$/i, "").toLowerCase();
    if (/bomb/.test(name)) return "Apparently ‘please move the bomb’ was treated as optional reading.";
    if (/cannon/.test(name)) return "The cannon and this player have unresolved personal business.";
    if (/oil/.test(name)) return "OSHA would like a word about the amount of oil-related workplace exposure.";
    if (/green/.test(name)) return "Green circles continue to be a surprisingly complicated social contract.";
    if (/teleport|port/.test(name)) return "Frequent flyer status has now been achieved.";
    if (/knock|launch|fear/.test(name)) return "Positioning was briefly reclassified as a suggestion.";
    if (/orb/.test(name)) return "The orb collection side quest appears to be going extremely well.";
    if (/slam|smash|shockwave/.test(name)) return "Saw the large attack and chose to experience it personally.";
    return "Once is an accident. Repeated appearances are starting to look like a subscription.";
  }

  function polishAwards() {
    document.querySelectorAll(".award-card").forEach((card) => {
      const titleEl = card.querySelector(".award-title");
      const roastEl = card.querySelector(".award-roast");
      const statEl = card.querySelector(".award-stat");
      if (!titleEl || !roastEl) return;
      const title = titleEl.textContent.trim();

      if (/^Floor\s+[RBG]\s+Specialist$/i.test(title) || /Floor\s+dmg/i.test(title)) {
        card.remove();
        return;
      }

      if (/\s+Specialist$/i.test(title)) {
        const mechanicName = title.replace(/\s+Specialist$/i, "");
        titleEl.textContent = "Repeat Customer";
        if (statEl && !statEl.dataset.polished) {
          statEl.textContent = `${mechanicName} · ${statEl.textContent}`;
          statEl.dataset.polished = "true";
        }
        roastEl.textContent = specificRoast(title);
        return;
      }

      if (descriptions[title] && roastEl.textContent !== descriptions[title]) {
        roastEl.textContent = descriptions[title];
      }
    });
  }

  const awardsGrid = document.getElementById("awards-grid");
  if (awardsGrid) {
    new MutationObserver(polishAwards).observe(awardsGrid, {
      childList: true,
      subtree: false,
    });
    polishAwards();
  }

  const copyButton = document.getElementById("copy-button");
  if (copyButton) {
    copyButton.addEventListener("click", async (event) => {
      const cards = [...document.querySelectorAll(".award-card")];
      if (!cards.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const lines = ["🏆 **GW2 RAID OSCARS**", ""];
      for (const card of cards) {
        const icon = card.querySelector(".award-icon")?.textContent.trim() || "🏅";
        const title = card.querySelector(".award-title")?.textContent.trim() || "Award";
        const winner = card.querySelector(".award-winner")?.textContent.trim() || "Unknown";
        const stat = card.querySelector(".award-stat")?.textContent.trim() || "";
        const roast = card.querySelector(".award-roast")?.textContent.trim() || "";
        lines.push(`${icon} **${title} — ${winner}**`);
        if (stat) lines.push(stat);
        if (roast) lines.push(`_${roast}_`);
        lines.push("");
      }

      const text = lines.join("\n").trim();
      try {
        await navigator.clipboard.writeText(text);
        const old = copyButton.textContent;
        copyButton.textContent = "Copied ✓";
        setTimeout(() => { copyButton.textContent = old; }, 1400);
      } catch {
        window.prompt("Copy this summary:", text);
      }
    }, true);
  }
})();