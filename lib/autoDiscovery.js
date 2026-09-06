const discovery = require("./discovery");

let timer = null;

/**
 * Kick off a repeating SSDP sweep in the background so the app stays
 * current on device online/offline state without the user ever having
 * to click "scan". Safe to call more than once -- a second call is a no-op
 * while a loop is already running.
 */
function start({ intervalMs = 30000, initialDelayMs = 0 } = {}) {
  if (timer) return;

  const tick = () => {
    discovery.discover(4000).catch((err) => {
      console.error(`Background discovery pass failed: ${err.message}`);
    });
  };

  setTimeout(tick, initialDelayMs);
  timer = setInterval(tick, intervalMs);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop };
