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
    const cleaned = full.replace(/\s*\((?:hit by|player hit by|damage from|dmg from)?[^)]*\)\s*$/i, "").trim();
    return cleaned || full || short;
  }

  function collapseRapidRepeats(events, cooldownMs) {
    if (!Array.isArray(events) || events.length < 2) return events || [];
    const minGap = Math.max(750, Number(cooldownMs) || 1250);
    const last = new Map();
    return events.filter((event) => {
      const actor = String(event?.actor || event?.instid || "unknown");
      const time = Number(event?.time);
      if (!Number.isFinite(time)) return true;
      const previous = last.get(actor);
      if (Number.isFinite(previous) && time - previous < minGap) return false;
      last.set(actor, time);
      return true;
    });
  }

  function cleanEliteInsightsJson(json) {
    if (!json || !Array.isArray(json.mechanics)) return json;
    json.mechanics = json.mechanics
      .filter(usefulMechanic)
      .map((m) => ({
        ...m,
        name: friendlyName(m),
        mechanicsData: collapseRapidRepeats(m.mechanicsData, m.internalCooldown),
      }))
      .filter((m) => m.mechanicsData.length > 0);
    return json;
  }

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    if (!/https:\/\/(?:b\.)?dps\.report\/getJson/i.test(url)) return response;

    try {
      const json = cleanEliteInsightsJson(await response.clone().json());
      return new Response(JSON.stringify(json), {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
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
    // Only watch direct children being replaced by app.js. Watching the full subtree
    // caused polishAwards() to trigger itself whenever it edited award text.
    new MutationObserver(() => polishAwards()).observe(awardsGrid, {
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