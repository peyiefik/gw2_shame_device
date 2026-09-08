(() => {
  "use strict";
  const NativeWorker = window.Worker;
  if (!NativeWorker) return;

  class RoutedPlayerWorker extends NativeWorker {
    constructor(url, options) {
      const raw = String(url || "");
      const target = raw.includes("player-worker.js") ? "player-worker-v2.js?v=1" : url;
      super(target, options);
    }
  }

  window.Worker = RoutedPlayerWorker;
})();
