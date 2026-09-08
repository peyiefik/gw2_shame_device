"use strict";

importScripts("player-worker.js?v=1");

subgroupCoverage = function patchedSubgroupCoverage(players, provider, uptimeKey, durationMS) {
  const hasUptime = (member) =>
    member[uptimeKey] !== null &&
    member[uptimeKey] !== undefined &&
    Number.isFinite(Number(member[uptimeKey]));

  const recipients = players.filter((member) =>
    member.group === provider.group &&
    member.account !== provider.account &&
    hasUptime(member)
  );
  const fallback = recipients.length
    ? recipients
    : players.filter((member) => member.group === provider.group && hasUptime(member));

  let weighted = 0;
  let weight = 0;
  for (const member of fallback) {
    const w = member.activeMs > 0 ? member.activeMs : Math.max(1, n(durationMS, 1));
    weighted += n(member[uptimeKey]) * w;
    weight += w;
  }

  return {
    uptime: weight > 0 ? weighted / weight : null,
    weight,
    recipients: fallback.length,
  };
};
