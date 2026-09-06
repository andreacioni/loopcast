# LoopCast

A minimal control point that sits between MiniDLNA (your library) and a DLNA
renderer (smart TV, etc.), adding one thing MiniDLNA lacks: **remembering
where you left off**.

It runs as a normal Node.js server on the Pi and serves a small web UI you
open from any browser on the LAN (phone, laptop, TV browser).

```
MiniDLNA (server)  <---SOAP/Browse--->  this app  <---AVTransport--->  Smart TV
                                            |
                                       resume.db (SQLite)
                                            |
                                      web UI (any browser)
```

## Setup on the Pi

```bash
npm install
npm start
```

Then visit `http://<pi-ip>:3000` from your phone or laptop's browser.

On first load, click **Rescan network** — this sends an SSDP search and
waits ~4 seconds for MiniDLNA and any renderers to answer. Pick your
library from the "Library" dropdown and your TV from "Play on", then browse
folders and click an item to play it.

If you've watched part of something before, you'll see a "resume Xh:Ym:Zs"
badge next to it, and you'll be asked whether to resume or start over when
you click it.

## How it works

- **`lib/discovery.js`** — SSDP `M-SEARCH` (`ssdp:all`) to find devices,
  then fetches and parses each device's `description.xml` to classify it
  as a MediaServer (MiniDLNA) or MediaRenderer (TV) and extract its
  service `controlURL`s.
- **`lib/contentDirectory.js`** — sends `Browse` SOAP requests to
  MiniDLNA's ContentDirectory service and parses the DIDL-Lite XML it
  returns into a plain JS folder/item list.
- **`lib/renderer.js`** — wraps `upnp-mediarenderer-client` to load/play
  media on the TV, and polls `GetPositionInfo` every 7s while playing to
  persist progress.
- **`lib/db.js`** — a tiny SQLite table (`resume`) keyed by MiniDLNA
  object ID, storing `{ position, duration, updated_at }`.
- **`server.js`** — Express API tying it together; **`public/`** is the
  plain HTML/JS frontend.

## API endpoints

| Method | Path             | Purpose                                     |
|--------|------------------|----------------------------------------------|
| GET    | `/api/devices`   | Run SSDP discovery, return servers+renderers |
| GET    | `/api/browse`    | Browse a folder (`?serverUsn=&objectId=`)    |
| POST   | `/api/play`      | Load+play an item, optionally resuming       |
| POST   | `/api/control`   | `pause` / `stop` / `resume-playback`         |
| GET    | `/api/status`    | Current position/duration for a renderer     |
| GET    | `/api/resumable` | All items with a saved resume position       |

## Known limitations (this is a starting scaffold, not production-ready)

- **Discovery is on-demand, not passive.** Real control points also listen
  passively for `ssdp:alive`/`byebye` NOTIFY broadcasts so the device list
  stays fresh without re-scanning. This scaffold only does active
  `M-SEARCH` on demand (button click). Worth adding if devices come and go
  often.
- **No auth.** Anything on your LAN that can reach port 3000 can control
  playback. Fine for a home LAN, not fine if the Pi is exposed further.
- **Single active renderer session per USN.** The renderer client is
  reused across play calls but there's no handling for two browser tabs
  fighting over the same TV.
- **Resume threshold is naive** (skips resume prompt under 5s in). You may
  want to also skip resuming near the very end of an item (e.g. last 30s)
  so credits-rolling episodes don't perpetually "resume" at the end.
- **No transcoding.** This only works for formats the TV's DLNA renderer
  natively supports — same as browsing MiniDLNA directly. If your TV
  rejects a file, that's a codec/container issue, not something this app
  can fix (MiniDLNA does no transcoding either).
- **Minimal error handling for flaky devices** — real DLNA renderers vary
  a lot in how strictly they implement AVTransport; expect to add
  TV-specific workarounds over time (e.g. some don't like Seek before
  playback fully starts, hence the 1.5s delay in `renderer.js`).

## Next steps worth investigating

- Passive SSDP listening (`node-ssdp`'s `Server`/`Client` can subscribe to
  `NOTIFY` broadcasts) to auto-refresh the device list.
- Persist discovered devices across restarts (right now the cache is
  in-memory and cleared on restart, requiring a rescan).
- A "continue watching" view driven by `/api/resumable`.
- Subscribing to `AVTransport` eventing (`eventSubURL`) instead of polling
  `GetPositionInfo`, for renderers that support it — cuts network chatter.
