(() => {
  "use strict";

  const input = document.getElementById("report-input");
  const analyze = document.getElementById("analyze-button");
  const leaderboard = document.getElementById("leaderboard-body");
  if (!input || !analyze || !leaderboard) return;

  function rememberLogs() {
    if (input.value.trim()) localStorage.setItem("gw2ShameLastReports", input.value);
  }

  function linkPlayers() {
    for (const name of leaderboard.querySelectorAll(".player-name")) {
      if (name.querySelector("a.player-inspect-link")) continue;
      const text = name.textContent.trim();
      if (!text) continue;
      const link = document.createElement("a");
      link.className = "player-inspect-link";
      link.href = `player.html?name=${encodeURIComponent(text)}`;
      link.title = `Inspect ${text}`;
      link.textContent = text;
      link.style.color = "inherit";
      link.style.textDecoration = "none";
      name.textContent = "";
      name.appendChild(link);
    }
  }

  analyze.addEventListener("click", rememberLogs);
  leaderboard.addEventListener("click", rememberLogs);
  new MutationObserver(linkPlayers).observe(leaderboard, { childList: true });
  linkPlayers();
})();
