const RendererClient = require("./upnp");
const { saveResume, getResume, clearResume } = require("./db");

// One live upnp-mediarenderer-client instance per renderer USN, plus the
// interval timer that polls playback position for resume tracking.
// `queue` holds items still waiting to be handed to the renderer;
// `nextItem` is whichever one was last given to it via
// SetNextAVTransportURI, so the renderer itself performs the gapless
// transition instead of us reloading media after detecting STOPPED.
const clients = new Map(); // usn -> { client, pollTimer, currentItemId, queue, nextItem, rendererDesc }

function getClient(rendererDesc) {
  let entry = clients.get(rendererDesc.usn);
  if (!entry) {
    const client = new RendererClient(rendererDesc.location);
    entry = {
      client,
      pollTimer: null,
      currentItemId: null,
      currentTitle: null,
      queue: [],
      nextItem: null,
      rendererDesc,
    };
    clients.set(rendererDesc.usn, entry);
  } else {
    entry.rendererDesc = rendererDesc;
  }
  return entry;
}

function itemMetadata(item) {
  return {
    id: item.id,
    parentId: item.id.split("$").slice(0, -1).join("$") || "-1",
    title: item.title,
    type: item.mediaKind,
    itemId: item.id,
  };
}

function toQueueEntry(item) {
  return {
    id: item.id,
    parentId: item.id.split("$").slice(0, -1).join("$") || "-1",
    title: item.title,
    type: item.mediaKind,
    url: item.mediaUrl,
    contentType: item.mimeType,
    dlnaFeatures: item.dlnaFeatures,
  };
}

/**
 * Hand the next queued item to the renderer via the native AVTransport
 * SetNextAVTransportURI action so it can gapless-transition on its own.
 * AVTransport only supports staging one lookahead item at a time, so this
 * is called again each time the renderer reports it has moved on to
 * `nextItem` -- loadQueue() only wires up the first two items for us.
 */
async function stageNextQueuedItem(entry) {
  if (entry.nextItem || entry.queue.length === 0) return;
  const item = entry.queue.shift();
  try {
    await entry.client.setNextAVTransportURI(item.mediaUrl, {
      metadata: itemMetadata(item),
      contentType: item.mimeType,
      dlnaFeatures: item.dlnaFeatures,
    });
    entry.nextItem = item;
  } catch (err) {
    console.warn(
      `Renderer does not support native queueing (SetNextAVTransportURI failed: ${err.message}) -- dropping queue.`,
    );
    entry.queue = [];
  }
}

function hmsToSeconds(hms) {
  if (!hms) return 0;
  const parts = hms.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function stopPolling(entry) {
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }
}

function startPolling(entry) {
  stopPolling(entry);
  let errorCount = 0;
  entry.pollTimer = setInterval(async () => {
    try {
      const seconds = await entry.client.getPosition();
      if (entry.currentItemId == null) return;
      const duration = await entry.client.getDuration();
      if (entry.currentItemId == null) return;
      console.log(
        `Renderer ${entry.client.deviceDescription.friendlyName} (${entry.client.deviceDescription.UDN}) ` +
          `position=${seconds}s duration=${duration}s`,
      );
      saveResume(entry.currentItemId, entry.currentTitle, seconds, duration);
      errorCount = 0; // reset on success

      // Only worth checking CurrentURI when we've actually staged a next
      // item -- that's the one signal that the renderer moved on by itself.
      if (entry.nextItem) {
        const mediaInfo = await entry.client.getMediaInfo();
        if (mediaInfo?.CurrentURI === entry.nextItem.mediaUrl) {
          clearResume(entry.currentItemId);
          entry.currentItemId = entry.nextItem.id;
          entry.currentTitle = entry.nextItem.title;
          entry.nextItem = null;
          await stageNextQueuedItem(entry);
        }
      }
    } catch (err) {
      console.error(`Failed to poll renderer position: ${err}`);
      errorCount += 1;
      if (errorCount >= 3) {
        console.error(
          `Too many consecutive errors polling renderer ${entry.client.deviceDescription.friendlyName} (${entry.client.deviceDescription.UDN}) -- stopping polling.`,
        );
        stopPolling(entry);
        return;
      }
    }
  }, 7000); // poll every 7s -- frequent enough to survive a crash, cheap enough to leave running
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function waitUntilPlaying(
  client,
  { timeoutMs = 10000, intervalMs = 400 } = {},
) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      client
        .getTransportInfo()
        .then((info) => {
          if (info && info.CurrentTransportState === "PLAYING")
            return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(check, intervalMs);
        })
        .catch(() => {
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(check, intervalMs);
        });
    };
    check();
  });
}

function seekViaAction(client, seconds, unit) {
  return client
    .seek(seconds, { unit })
    .then(() => null)
    .catch((err) => err.message);
}

/**
 * Snapshot everything the renderer reports about the current transport
 * right before we attempt a seek. When Seek fails for reasons that
 * aren't just "still buffering", the most common culprits are: the
 * renderer hasn't resolved a real track duration yet (some firmwares
 * refuse to Seek at all until GetMediaInfo reports something other than
 * "00:00:00" / "NOT_IMPLEMENTED"), or it's not actually in the state it
 * claims. Logging this is far more useful than guessing blind.
 */
function snapshotTransport(client) {
  return new Promise((resolve) => {
    Promise.allSettled([
      client.getTransportInfo(),
      new Promise((resolveAction, rejectAction) => {
        client.callAction(
          "AVTransport",
          "GetMediaInfo",
          { InstanceID: 0 },
          (err, result) => (err ? rejectAction(err) : resolveAction(result)),
        );
      }),
    ]).then(([transportResult, mediaResult]) => {
      resolve({
        transportState:
          transportResult.status === "rejected"
            ? `error: ${transportResult.reason.message}`
            : transportResult.value?.CurrentTransportState,
        transportStatus:
          transportResult.status === "rejected"
            ? undefined
            : transportResult.value?.CurrentTransportStatus,
        mediaDuration:
          mediaResult.status === "rejected"
            ? `error: ${mediaResult.reason.message}`
            : mediaResult.value?.MediaDuration,
      });
    });
  });
}

async function seekWithRetry(client, seconds, attempts = 3) {
  const snapshot = await snapshotTransport(client);
  console.log(
    `Attempting resume seek to ${seconds}s. Renderer reports: ` +
      `state=${snapshot.transportState} status=${snapshot.transportStatus} ` +
      `mediaDuration=${snapshot.mediaDuration}`,
  );

  // Try the standard REL_TIME unit first (what almost all renderers
  // expect), retrying since some genuinely just need a moment more after
  // reaching PLAYING. If every REL_TIME attempt fails, some renderers'
  // Seek implementations only recognize ABS_TIME despite both being
  // valid per the AVTransport spec -- worth one shot before giving up.
  for (let i = 0; i < attempts; i++) {
    const error = await seekViaAction(client, seconds, "REL_TIME");
    if (!error) return { applied: true, unit: "REL_TIME", snapshot };
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    else {
      const fallbackError = await seekViaAction(client, seconds, "ABS_TIME");
      if (!fallbackError) return { applied: true, unit: "ABS_TIME", snapshot };
      return {
        applied: false,
        error: `REL_TIME: ${error} / ABS_TIME: ${fallbackError}`,
        snapshot,
      };
    }
  }
}

function callActionWithRetry(
  client,
  service,
  action,
  params,
  { attempts = 6, delayMs = 800 } = {},
) {
  return new Promise((resolve, reject) => {
    let attemptsLeft = attempts;
    const attempt = () => {
      client.callAction(service, action, params, (err, result) => {
        if (!err) return resolve(result);
        attemptsLeft -= 1;
        if (attemptsLeft <= 0) return reject(err);
        setTimeout(attempt, delayMs);
      });
    };
    attempt();
  });
}

/**
 * Some renderers begin playback automatically as soon as
 * SetAVTransportURI succeeds, without waiting for (or even accepting) an
 * explicit Play afterward -- calling Play while they're already playing,
 * or already transitioning into playing on their own, is a transition
 * that genuinely isn't available, and some renderers report that as
 * "701 - Transition not available". So: check the real state first and
 * only call Play if the renderer is actually sitting there waiting for
 * it. If Play still somehow errors, recheck once more before giving up --
 * a few renderers report a spurious Play failure despite already playing
 * by the time you look again.
 */
async function ensurePlaying(client) {
  const alreadyPlaying = await waitUntilPlaying(client, {
    timeoutMs: 3000,
    intervalMs: 300,
  });
  if (alreadyPlaying) {
    console.log(
      "Renderer already playing after SetAVTransportURI -- skipping explicit Play.",
    );
    return;
  }

  try {
    await callActionWithRetry(client, "AVTransport", "Play", {
      InstanceID: 0,
      Speed: 1,
    });
  } catch (playErr) {
    const recheck = await waitUntilPlaying(client, {
      timeoutMs: 1500,
      intervalMs: 300,
    });
    if (recheck) {
      console.warn(
        `Play action failed (${playErr.message}) but renderer is playing anyway -- continuing.`,
      );
      return;
    }
    throw playErr;
  }
}

/**
 * Load and play a media item on a renderer. If a resume position exists
 * for this itemId, the caller decides (via `resumeSeconds`) whether to
 * seek there after playback starts; pass 0/undefined to start from scratch.
 */
async function play(
  rendererDesc,
  {
    itemId,
    title,
    mediaUrl,
    mimeType,
    dlnaFeatures,
    mediaKind,
    resumeSeconds,
    queue,
  },
) {
  console.log(
    `Loading "${title}" on renderer ${rendererDesc.friendlyName} (${rendererDesc.usn}), mediaUrl=${mediaUrl}, resumeSeconds=${resumeSeconds}`,
  );
  const entry = getClient(rendererDesc);

  if (entry.currentItemId && itemId != entry.currentItemId) {
    try {
      await entry.client.stop();
    } catch (err) {
      console.error(`Renderer stop failed for "${title}": ${err}`);
    }
  }

  entry.currentItemId = itemId;
  entry.currentTitle = title;
  entry.lastResumeAttempt = null;

  const fullQueue = Array.isArray(queue) ? queue.slice() : [];

  // Hand the current item plus the queue to the renderer in one call --
  // SetAVTransportURI for the current item and (natively) an immediate
  // SetNextAVTransportURI for the one right after it, without autoplay
  // so it's already primed before Play starts. Some renderers (e.g.
  // Samsung TVs) only reliably accept SetNextAVTransportURI while not
  // yet playing.
  await entry.client.load(mediaUrl, {
    autoplay: true,
    metadata: {
      id: itemId,
      title,
      mediaUrl,
      mimeType,
      dlnaFeatures,
      type: mediaKind,
    },
  });
  //await ensurePlaying(entry.client);

  // AVTransport only supports staging one lookahead item at a time --
  // stageNextQueuedItem() actually calls SetNextAVTransportURI for the
  // first item; anything beyond that is staged progressively as playback
  // advances.
  entry.nextItem = null;
  entry.queue = fullQueue;

  stageNextQueuedItem(entry).catch((err) =>
    console.error(`Failed to stage next queued item: ${err}`),
  );

  if (resumeSeconds && resumeSeconds > 5) {
    retry(() =>
      entry.client
        .seek(resumeSeconds, { unit: "ABS_TIME" })
        .catch((seekErr) => {
          throw `Renderer seek failed for "${title}": ${seekErr}`;
        }),
    )
      .catch((err) => console.log(err))
      .finally(() => {
        startPolling(entry);
      });
  } else {
    startPolling(entry);
  }
}

function retry(fn, { attempts = 10, delayMs = 700 } = {}) {
  return new Promise((resolve, reject) => {
    let attemptsLeft = attempts;
    const attempt = () => {
      fn()
        .then(resolve)
        .catch((err) => {
          attemptsLeft -= 1;
          if (attemptsLeft <= 0) return reject(err);
          setTimeout(attempt, delayMs);
        });
    };
    attempt();
  });
}

async function control(rendererDesc, action) {
  const entry = getClient(rendererDesc);
  if (action === "pause") return entry.client.pause();
  if (action === "stop") {
    entry.queue = [];
    entry.nextItem = null;
    stopPolling(entry);
    return entry.client.stop();
  }
  if (action === "resume-playback") return entry.client.play();
  throw new Error(`Unknown action: ${action}`);
}

async function status(rendererDesc) {
  const entry = getClient(rendererDesc);
  const [positionResult, durationResult] = await Promise.allSettled([
    entry.client.getPosition(),
    entry.client.getDuration(),
  ]);
  const resumeRow = entry.currentItemId ? getResume(entry.currentItemId) : null;
  return {
    itemId: entry.currentItemId,
    title: entry.currentTitle,
    queueLength: entry.queue.length + (entry.nextItem ? 1 : 0),
    position:
      positionResult.status === "fulfilled" ? positionResult.value : null,
    duration:
      durationResult.status === "fulfilled" ? durationResult.value : null,
    savedResume: resumeRow || null,
    lastResumeAttempt: entry.lastResumeAttempt || null,
  };
}

module.exports = { play, control, status, hmsToSeconds };
