(() => {
  "use strict";
  const NativeWorker = window.Worker;
  if (!NativeWorker) return;

  class RoutedWorker extends NativeWorker {
    constructor(url, options) {
      const raw = String(url || "");
      const target = raw.includes("worker-v6.js") ? "worker-v7.js?v=1" : url;
      super(target, options);
    }
  }

  window.Worker = RoutedWorker;
})();
