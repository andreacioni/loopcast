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
      if (!Number.isFinite(seconds)) return;

      let duration = 0;
      try {
        duration = await entry.client.getDuration();
        if (!Number.isFinite(duration)) duration = 0;
      } catch (err) {
        console.warn(`Failed to read renderer duration: ${err.message}`);
      }

      if (entry.currentItemId == null && seconds / duration > 0.95) return;

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
    await client.play();
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

// Probe the live media URL to get accurate MIME type and DLNA features, falling back to defaults if necessary.
async function getMediaInfo(mediaUrl) {
  try {
    const res = await fetch(mediaUrl, { method: "HEAD", timeout: 4000 });
    const contentType = res.headers.get("content-type") || "video/mpeg";
    const dlnaFeatures = res.headers.get("contentfeatures.dlna.org") || "*";
    return { contentType, dlnaFeatures };
  } catch (err) {
    console.warn(
      `Live HEAD probe failed for ${mediaUrl}, falling back to Browse metadata: ${err.message}`,
    );
    return {
      contentType: "video/mpeg",
      dlnaFeatures: "*",
    };
  }
}

/**
 * Load and play a media item on a renderer. If a resume position exists
 * for this itemId, the caller decides (via `resumeSeconds`) whether to
 * seek there after playback starts; pass 0/undefined to start from scratch.
 */
async function play(
  renderer,
  {
    itemId,
    title,
    mediaUrl,
    mimeType,
    dlnaFeatures,
    mediaKind,
    resumeSeconds,
    duration,
    size,
    queue,
  },
) {
  console.log(
    `Loading "${title}" on renderer ${renderer.friendlyName} (${renderer.usn}), mediaUrl=${mediaUrl}, duration=${duration}, size=${size}, resumeSeconds=${resumeSeconds}`,
  );
  const client = getClient(renderer);
  const isResuming = resumeSeconds && resumeSeconds > 5;

  //let intervalId = setInterval(() => {
  //  entry.client
  //    .getCurrentTransportActions()
  //    .catch((err) => {
  //      console.error(
  //        `Failed to get current transport actions for "${title}": ${err}`,
  //      );
  //    })
  //    .then((actions) => {
  //      console.log(
  //        `Current transport actions for "${title}": ${JSON.stringify(actions)}`,
  //      );
  //    });
  //}, 500);

  //if (entry.currentItemId && itemId != entry.currentItemId) {
  //  try {
  //    await entry.client.stop();
  //  } catch (err) {
  //    console.error(`Renderer stop failed for "${title}": ${err}`);
  //  }
  //} else {
  //  await entry.client.pause().catch((err) => {
  //    console.error(`Renderer pause failed for "${title}": ${err}`);
  //  });
  //}
  //await client.client.stop().catch((err) => {
  //  console.error(`Renderer stop failed for "${title}": ${err}`);
  //});

  client.currentItemId = itemId;
  client.currentTitle = title;
  client.lastResumeAttempt = null;

  const fullQueue = Array.isArray(queue) ? queue.slice() : [];

  // Ensure we have the correct MIME type and DLNA features for this media URL.
  // On MiniDLNA, the MIME type and DLNA features may not be correctly reported
  // in the metadata, so we probe the live URL to get accurate information.
  if (!mimeType || !dlnaFeatures || dlnaFeatures === "*") {
    const mediaInfo = await getMediaInfo(mediaUrl);
    mimeType = mediaInfo.contentType;
    dlnaFeatures = mediaInfo.dlnaFeatures;
  }

  await client.client.load(mediaUrl, {
    autoplay: !isResuming,
    dlnaFeatures: dlnaFeatures,
    contentType: mimeType,
    metadata: {
      id: itemId,
      title,
      mediaUrl,
      duration,
      size,
      type: mediaKind,
    },
  });

  //await retry(() => entry.client.pause()).catch((err) => {
  //  console.error(`Renderer pause failed for "${title}": ${err}`);
  //});

  // AVTransport only supports staging one lookahead item at a time --
  // stageNextQueuedItem() actually calls SetNextAVTransportURI for the
  // first item; anything beyond that is staged progressively as playback
  // advances.
  client.nextItem = null;
  client.queue = fullQueue;

  if (isResuming) {
    retry(() => client.client.seek(320, { unit: "ABS_TIME" }), {
      attempts: 50,
      delayMs: 100,
    }).catch((err) => {
      console.error(`Renderer seek failed for "${title}": ${err}`);
    });
  }

  await ensurePlaying(client.client);

  stageNextQueuedItem(client).catch((err) =>
    console.error(`Failed to stage next queued item: ${err}`),
  );

  try {
    startPolling(client);
  } catch (err) {
    console.error(`Failed to start polling: ${err}`);
  }

  //setTimeout(() => {
  //  clearInterval(intervalId);
  //}, 2000);
}

function retry(fn, { attempts = 10, delayMs = 100 } = {}) {
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
