async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

function postJson(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const getDevices = () => api("/api/devices");

export const setDiscovery = (enabled, durationMs) =>
  postJson("/api/devices/discovery", { enabled, durationMs });

export const getFolder = (serverUsn, objectId) =>
  api(
    `/api/browse?serverUsn=${encodeURIComponent(serverUsn)}&objectId=${encodeURIComponent(objectId)}`,
  );

export const getHome = (serverUsn) =>
  api(`/api/home?serverUsn=${encodeURIComponent(serverUsn)}`);

export const getStatus = (rendererUsn) =>
  api(`/api/status?rendererUsn=${encodeURIComponent(rendererUsn)}`);

export const playMedia = ({
  rendererUsn,
  item,
  resume,
  queue,
}) =>
  postJson("/api/play", {
    rendererUsn,
    itemId: item.id,
    title: item.title,
    mediaUrl: item.mediaUrl,
    mimeType: item.mimeType,
    dlnaFeatures: item.dlnaFeatures,
    mediaKind: item.mediaKind,
    duration: item.duration,
    size: item.size,
    resume,
    queue,
  });

export const controlRenderer = (rendererUsn, action) =>
  postJson("/api/control", { rendererUsn, action });
