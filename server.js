const path = require('path');
const express = require('express');
const discovery = require('./lib/discovery');
const contentDirectory = require('./lib/contentDirectory');
const renderer = require('./lib/renderer');
const { getResume, listResumable, close: closeDb } = require('./lib/db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Helper: find the ContentDirectory controlURL on a discovered server device.
function contentDirectoryUrl(device) {
  const svc = device.services.find((s) =>
    s.serviceType.includes('ContentDirectory')
  );
  if (!svc) throw new Error(`${device.friendlyName} has no ContentDirectory service`);
  return svc.controlURL;
}

// --- Discovery -------------------------------------------------------

app.get('/api/devices', async (req, res) => {
  try {
    const devices = await discovery.discover(4000);
    res.json({
      servers: devices.filter((d) => d.kind === 'server'),
      renderers: devices.filter((d) => d.kind === 'renderer'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Browsing a MiniDLNA library --------------------------------------

app.get('/api/browse', async (req, res) => {
  const { serverUsn, objectId = '0' } = req.query;
  const device = discovery.getCached(serverUsn);
  if (!device) return res.status(404).json({ error: 'Unknown server; call /api/devices first' });

  try {
    const controlURL = contentDirectoryUrl(device);
    const result = await contentDirectory.browse(controlURL, objectId);

    // Annotate items with any saved resume position so the UI can show
    // "Resume at 12:34" without a second round trip.
    result.items = result.items.map((item) => ({
      ...item,
      resume: getResume(item.id) || null,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Playback control --------------------------------------------------

app.post('/api/play', async (req, res) => {
  const { rendererUsn, itemId, title, mediaUrl, mimeType, dlnaFeatures, mediaKind, resume } = req.body;
  const device = discovery.getCached(rendererUsn);
  if (!device) return res.status(404).json({ error: 'Unknown renderer; call /api/devices first' });

  try {
    const saved = getResume(itemId);
    const resumeSeconds = resume && saved ? saved.position : 0;
    await renderer.play(device, { itemId, title, mediaUrl, mimeType, dlnaFeatures, mediaKind, resumeSeconds });
    res.json({ ok: true, resumedAt: resumeSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/control', async (req, res) => {
  const { rendererUsn, action } = req.body; // action: 'pause' | 'stop' | 'resume-playback'
  const device = discovery.getCached(rendererUsn);
  if (!device) return res.status(404).json({ error: 'Unknown renderer; call /api/devices first' });

  try {
    await renderer.control(device, action);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  const { rendererUsn } = req.query;
  const device = discovery.getCached(rendererUsn);
  if (!device) return res.status(404).json({ error: 'Unknown renderer; call /api/devices first' });

  try {
    const s = await renderer.status(device);
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resumable', (req, res) => {
  res.json(listResumable());
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`DLNA resume control point running at http://<pi-ip>:${PORT}`);
});

// Close the SQLite handle explicitly on shutdown rather than letting the
// process die with statements/timers still live -- letting Node tear down
// native handles implicitly on exit is the situation that tends to surface
// better-sqlite3's native cleanup-hook assertion.
function shutdown() {
  server.close();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
