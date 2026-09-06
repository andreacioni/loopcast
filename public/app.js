const state = {
  servers: [],
  renderers: [],
  currentServerUsn: null,
  currentRendererUsn: null,
  path: [{ id: "0", title: "Root" }],
};

const el = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// Cheap poll against the background auto-discovery cache. No scanning
// happens here, so this is safe to call frequently.
async function refreshDevices() {
  try {
    const { servers, renderers } = await api("/api/devices");
    const hadNoServer = !state.currentServerUsn;
    state.servers = servers;
    state.renderers = renderers;
    renderDeviceSelects();
    if (hadNoServer && state.currentServerUsn) {
      state.path = [{ id: "0", title: "Root" }];
      loadFolder("0");
    }
  } catch (err) {
    console.warn(`Device refresh failed: ${err.message}`);
  }
}

async function rescanNow() {
  el("discoverBtn").textContent = "Scanning...";
  try {
    await api("/api/devices/rescan", { method: "POST" });
    await refreshDevices();
  } catch (err) {
    alert(`Rescan failed: ${err.message}`);
  } finally {
    el("discoverBtn").textContent = "Rescan now";
  }
}

function renderDeviceSelects() {
  const serverSelect = el("serverSelect");
  const rendererSelect = el("rendererSelect");

  const statusLabel = (d) => (d.status === "online" ? "" : " (offline)");

  const prevServer = state.currentServerUsn;
  const prevRenderer = state.currentRendererUsn;

  serverSelect.innerHTML = state.servers
    .map(
      (s) =>
        `<option value="${s.usn}">${s.friendlyName}${statusLabel(s)}</option>`,
    )
    .join("");
  rendererSelect.innerHTML = state.renderers
    .map(
      (r) =>
        `<option value="${r.usn}">${r.friendlyName}${statusLabel(r)}</option>`,
    )
    .join("");

  // Preserve the current selection across refreshes; only fall back to
  // "first device" if nothing was selected yet or the selection vanished.
  const stillHasServer = state.servers.some((s) => s.usn === prevServer);
  const stillHasRenderer = state.renderers.some((r) => r.usn === prevRenderer);

  state.currentServerUsn = stillHasServer
    ? prevServer
    : state.servers[0]?.usn || null;
  state.currentRendererUsn = stillHasRenderer
    ? prevRenderer
    : state.renderers[0]?.usn || null;

  serverSelect.value = state.currentServerUsn || "";
  rendererSelect.value = state.currentRendererUsn || "";
}

async function loadFolder(objectId) {
  if (!state.currentServerUsn) return;
  const data = await api(
    `/api/browse?serverUsn=${encodeURIComponent(state.currentServerUsn)}&objectId=${encodeURIComponent(objectId)}`,
  );
  renderBreadcrumbs();
  renderList(data);
}

function renderBreadcrumbs() {
  el("breadcrumbs").innerHTML = state.path
    .map((p, i) => `<span data-idx="${i}">${p.title}</span>`)
    .join(" / ");

  el("breadcrumbs")
    .querySelectorAll("span")
    .forEach((span) => {
      span.addEventListener("click", () => {
        const idx = Number(span.dataset.idx);
        state.path = state.path.slice(0, idx + 1);
        loadFolder(state.path[idx].id);
      });
    });
}

function formatSeconds(s) {
  if (!s && s !== 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec]
    .map((n, i) => (i === 0 && n === 0 ? null : String(n).padStart(2, "0")))
    .filter(Boolean)
    .join(":");
}

function renderList({ containers, items }) {
  const list = el("itemList");
  list.innerHTML = "";

  containers.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>&#128193; ${c.title}</span><span class="badge">${c.childCount ?? ""} items</span>`;
    li.addEventListener("click", () => {
      state.path.push({ id: c.id, title: c.title });
      loadFolder(c.id);
    });
    list.appendChild(li);
  });

  items.forEach((item) => {
    const li = document.createElement("li");
    const resumeBadge = item.resume
      ? `<span class="badge">resume ${formatSeconds(item.resume.position)}</span>`
      : "";
    li.innerHTML = `<span>&#127916; ${item.title}</span>${resumeBadge}`;
    li.addEventListener("click", () => playItem(item));
    list.appendChild(li);
  });
}

async function playItem(item) {
  if (!state.currentRendererUsn) {
    alert("Pick a renderer first.");
    return;
  }

  let resume = false;
  if (item.resume && item.resume.position > 5) {
    resume = confirm(
      `Resume "${item.title}" at ${formatSeconds(item.resume.position)}? Cancel to start over.`,
    );
  }

  try {
    await api("/api/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rendererUsn: state.currentRendererUsn,
        itemId: item.id,
        title: item.title,
        mediaUrl: item.mediaUrl,
        mimeType: item.mimeType,
        dlnaFeatures: item.dlnaFeatures,
        mediaKind: item.mediaKind,
        resume,
      }),
    });
    showNowPlaying(item.title);
  } catch (err) {
    alert(`Playback failed: ${err.message}`);
  }
}

let statusTimer = null;

function showNowPlaying(title) {
  el("nowPlaying").classList.remove("hidden");
  el("npTitle").textContent = title;
  el("npResumeNote").textContent = "";
  state.reportedResumeAt = null;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 5000);
  pollStatus();
}

async function pollStatus() {
  if (!state.currentRendererUsn) return;
  try {
    const s = await api(
      `/api/status?rendererUsn=${encodeURIComponent(state.currentRendererUsn)}`,
    );
    el("npPosition").textContent =
      `${formatSeconds(s.position)} / ${formatSeconds(s.duration)}`;

    if (s.lastResumeAttempt && !state.reportedResumeAt) {
      state.reportedResumeAt = s.lastResumeAttempt.at;
      if (s.lastResumeAttempt.applied) {
        el("npResumeNote").textContent =
          `Resumed at ${formatSeconds(s.lastResumeAttempt.requestedSeconds)} (${s.lastResumeAttempt.unit})`;
      } else {
        const snap = s.lastResumeAttempt.transportSnapshot;
        const detail = snap
          ? ` [renderer state: ${snap.transportState}, duration: ${snap.mediaDuration}]`
          : "";
        el("npResumeNote").textContent =
          `Could not resume (${s.lastResumeAttempt.error || "unknown error"}) — playing from the start${detail}`;
      }
    }
  } catch (err) {
    // renderer may have dropped off the network -- ignore transient errors
  }
}

el("discoverBtn").addEventListener("click", rescanNow);
el("serverSelect").addEventListener("change", (e) => {
  state.currentServerUsn = e.target.value;
  state.path = [{ id: "0", title: "Root" }];
  loadFolder("0");
});
el("rendererSelect").addEventListener("change", (e) => {
  state.currentRendererUsn = e.target.value;
});
el("pauseBtn").addEventListener("click", async () => {
  await api("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rendererUsn: state.currentRendererUsn,
      action: "pause",
    }),
  }).catch((err) => alert(err.message));
});
el("stopBtn").addEventListener("click", async () => {
  await api("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rendererUsn: state.currentRendererUsn,
      action: "stop",
    }),
  }).catch((err) => alert(err.message));
  el("nowPlaying").classList.add("hidden");
  clearInterval(statusTimer);
});

refreshDevices();
setInterval(refreshDevices, 8000); // pick up online/offline flips from the background scanner
