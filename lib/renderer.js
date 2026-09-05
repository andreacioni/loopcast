const RendererClient = require('./upnp');
const { saveResume, getResume } = require('./db');

// One live upnp-mediarenderer-client instance per renderer USN, plus the
// interval timer that polls playback position for resume tracking.
const clients = new Map(); // usn -> { client, pollTimer, currentItemId }

function getClient(rendererDesc) {
  let entry = clients.get(rendererDesc.usn);
  if (!entry) {
    const client = new RendererClient(rendererDesc.location);
    entry = { client, pollTimer: null, currentItemId: null, currentTitle: null };
    clients.set(rendererDesc.usn, entry);
  }
  return entry;
}

function hmsToSeconds(hms) {
  if (!hms) return 0;
  const parts = hms.split(':').map(Number);
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
  entry.pollTimer = setInterval(() => {
    entry.client.getPosition((err, seconds) => {
      if (err || entry.currentItemId == null) return;
      entry.client.getDuration((durErr, duration) => {
        saveResume(
          entry.currentItemId,
          entry.currentTitle,
          seconds,
          durErr ? 0 : duration
        );
      });
    });
  }, 7000); // poll every 7s -- frequent enough to survive a crash, cheap enough to leave running
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OBJECT_CLASSES = {
  audio: 'object.item.audioItem.musicTrack',
  video: 'object.item.videoItem.movie',
  image: 'object.item.imageItem.photo',
};

function buildDidlLite({ title, mediaUrl, mimeType, dlnaFeatures, mediaKind }) {
  const protocolInfo = `http-get:*:${mimeType || 'video/mpeg'}:${dlnaFeatures || '*'}`;
  const objectClass = OBJECT_CLASSES[mediaKind] || OBJECT_CLASSES.video;
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<upnp:class>${objectClass}</upnp:class>` +
    `<res protocolInfo="${xmlEscape(protocolInfo)}">${xmlEscape(mediaUrl)}</res>` +
    '</item></DIDL-Lite>'
  );
}

function waitUntilPlaying(client, { timeoutMs = 10000, intervalMs = 400 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      client.getTransportInfo((err, info) => {
        if (!err && info && info.CurrentTransportState === 'PLAYING') return resolve(true);
        if (Date.now() >= deadline) return resolve(false); // give up but still let the caller try the seek
        setTimeout(check, intervalMs);
      });
    };
    check();
  });
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function seekViaAction(client, seconds, unit) {
  return new Promise((resolve) => {
    client.callAction(
      'AVTransport',
      'Seek',
      { InstanceID: 0, Unit: unit, Target: formatTime(seconds) },
      (err) => resolve(err ? err.message : null)
    );
  });
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
    client.getTransportInfo((tiErr, transportInfo) => {
      client.callAction('AVTransport', 'GetMediaInfo', { InstanceID: 0 }, (miErr, mediaInfo) => {
        resolve({
          transportState: tiErr ? `error: ${tiErr.message}` : transportInfo?.CurrentTransportState,
          transportStatus: tiErr ? undefined : transportInfo?.CurrentTransportStatus,
          mediaDuration: miErr ? `error: ${miErr.message}` : mediaInfo?.MediaDuration,
        });
      });
    });
  });
}

async function seekWithRetry(client, seconds, attempts = 3) {
  const snapshot = await snapshotTransport(client);
  console.log(
    `Attempting resume seek to ${seconds}s. Renderer reports: ` +
      `state=${snapshot.transportState} status=${snapshot.transportStatus} ` +
      `mediaDuration=${snapshot.mediaDuration}`
  );

  // Try the standard REL_TIME unit first (what almost all renderers
  // expect), retrying since some genuinely just need a moment more after
  // reaching PLAYING. If every REL_TIME attempt fails, some renderers'
  // Seek implementations only recognize ABS_TIME despite both being
  // valid per the AVTransport spec -- worth one shot before giving up.
  for (let i = 0; i < attempts; i++) {
    
    const error = await seekViaAction(client, seconds, 'REL_TIME');
    if (!error) return { applied: true, unit: 'REL_TIME', snapshot };
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    else {
      const fallbackError = await seekViaAction(client, seconds, 'ABS_TIME');
      if (!fallbackError) return { applied: true, unit: 'ABS_TIME', snapshot };
      return { applied: false, error: `REL_TIME: ${error} / ABS_TIME: ${fallbackError}`, snapshot };
    }
  }
}

function callActionWithRetry(client, service, action, params, { attempts = 6, delayMs = 800 } = {}) {
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
  const alreadyPlaying = await waitUntilPlaying(client, { timeoutMs: 3000, intervalMs: 300 });
  if (alreadyPlaying) {
    console.log('Renderer already playing after SetAVTransportURI -- skipping explicit Play.');
    return;
  }

  try {
    await callActionWithRetry(client, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  } catch (playErr) {
    const recheck = await waitUntilPlaying(client, { timeoutMs: 1500, intervalMs: 300 });
    if (recheck) {
      console.warn(`Play action failed (${playErr.message}) but renderer is playing anyway -- continuing.`);
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
async function play(rendererDesc, { itemId, title, mediaUrl, mimeType, dlnaFeatures, mediaKind, resumeSeconds }) {
  console.log(`Loading "${title}" on renderer ${rendererDesc.friendlyName} (${rendererDesc.usn}), mediaUrl=${mediaUrl}, resumeSeconds=${resumeSeconds}`);
  const entry = getClient(rendererDesc);

  if(itemId != entry.currentItemId) {
    entry.client.stop((err) => {
      if(err) console.error(`Renderer stop failed for "${title}": ${err}`);
    });
  }

  entry.currentItemId = itemId;
  entry.currentTitle = title;
  entry.lastResumeAttempt = null;

  const metadata = buildDidlLite({ title, mediaUrl, mimeType, dlnaFeatures, mediaKind });

  const resume = resumeSeconds && resumeSeconds > 5;
  const opts = { metadata, autoplay: true };
  
  entry.client.load(mediaUrl, opts, (err) => {
    if (err) console.error(`Renderer load failed for "${title}": ${err}`);

    if(resumeSeconds && resumeSeconds > 5) {
        retry(() => {
          return new Promise((res, rej) => {
            entry.client.seek(resumeSeconds, {unit: 'ABS_TIME'}, (seekErr) => {
              if (seekErr) rej(`Renderer seek failed for "${title}": ${seekErr}`)
              else res()
            });
          })
        }).catch((err) => {
          console.log(err);
        })
        
      //retry(() => new Promise((resolve, reject) => {
      //  entry.client.seek(resumeSeconds, {unit: 'REL_TIME'}, (seekErr) => {
      //    if (seekErr) reject(`Renderer seek failed for "${title}": ${seekErr}`)
      //    else resolve();
      //  });
      //}));
    }

    startPolling(entry);
  });

  

  //await ensurePlaying(entry.client);

  
}

function retry(fn, { attempts = 10, delayMs = 500 } = {}) {
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

function control(rendererDesc, action) {
  return new Promise((resolve, reject) => {
    const entry = getClient(rendererDesc);
    const done = (err) => (err ? reject(err) : resolve());

    if (action === 'pause') entry.client.pause(done);
    else if (action === 'stop') {
      stopPolling(entry);
      entry.client.stop(done);
    } else if (action === 'resume-playback') entry.client.play(done);
    else reject(new Error(`Unknown action: ${action}`));
  });
}

function status(rendererDesc) {
  return new Promise((resolve, reject) => {
    const entry = getClient(rendererDesc);
    entry.client.getPosition((posErr, position) => {
      entry.client.getDuration((durErr, duration) => {
        const resumeRow = entry.currentItemId ? getResume(entry.currentItemId) : null;
        resolve({
          itemId: entry.currentItemId,
          title: entry.currentTitle,
          position: posErr ? null : position,
          duration: durErr ? null : duration,
          savedResume: resumeRow || null,
          lastResumeAttempt: entry.lastResumeAttempt || null,
        });
      });
    });
  });
}

module.exports = { play, control, status, hmsToSeconds };
