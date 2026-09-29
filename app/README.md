# LoopCast (React)

This is a React (Vite) port of the original vanilla JS/HTML/CSS LoopCast
frontend. It talks to the same backend and the same `/api/*` endpoints as
before — no server-side changes are needed.

## Structure

```
src/
  api.js                  fetch wrappers for every /api/* call
  utils.js                formatSeconds() + resume-progress helper
  App.jsx                 top-level state & data flow (path, folder, cards, playback)
  main.jsx                entry point, wraps App in the Toast/Confirm providers
  index.css               ported almost verbatim from style.css
  hooks/
    useDevices.js         servers/renderers list, selection, discovery countdown
    useStatusPolling.js   5s poll of renderer transport status (now-playing bar)
    useToast.jsx          replaces window.alert — <ToastProvider> + useToast()
    useConfirm.jsx        replaces window.confirm — <ConfirmProvider> + useConfirm()
  components/
    Header.jsx            title + "Enable discovery" button
    DeviceBar.jsx         library / renderer <select> dropdowns
    ContinueWatching.jsx  resume carousel
    Breadcrumbs.jsx
    ItemList.jsx          folders + media items list
    ProgressBar.jsx        shared resume-progress bar (used by ItemList & ContinueWatching)
    NowPlayingBar.jsx     fixed footer with transport controls
```

## Running it

```bash
npm install
npm run dev
```

By default `vite.config.js` proxies `/api/*` requests in dev to
`http://localhost:3000` — update the `target` there to match wherever your
LoopCast backend actually runs.

For production, run `npm run build` and serve the generated `dist/` folder
from the same origin as the backend (or configure your server to proxy
`/api/*` through to it), exactly as the original static files were served.

## Notes on the conversion

- All DOM manipulation (`innerHTML`, `addEventListener`, `classList`) was
  replaced with React state and conditional rendering.
- `window.alert` → `useToast()` (a small toast queue/context).
- `window.confirm` → `useConfirm()` (a promise-based modal, same
  Cancel/Start over/Resume flow as the original custom modal).
- Polling loops (`setInterval` for devices, discovery countdown, and
  renderer status) are now `useEffect`-driven hooks that clean up on
  unmount.
- One quirk carried over intentionally: the resume note under the
  now-playing title recalculates on every 5-second status poll (rather
  than being shown once), matching the original `pollStatus()` behavior.
