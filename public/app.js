const state = {
  servers: [],
  renderers: [],
  currentServerUsn: null,
  currentRendererUsn: null,
  path: [{ id: "0", title: "Root" }], // breadcrumb stack
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

// --- Toast (replaces window.alert) --------------------------------------

let toastTimer = null;

function showToast(message, type = "error") {
  const toast = el("toast");
  toast.textContent = message;
  toast.className = `${type}`; // 'error' | 'info'
  // force reflow so repeated toasts re-trigger the transition
  void toast.offsetWidth;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

// --- Confirm modal (replaces window.confirm) ----------------------------

/**
 * Shows a modal with an arbitrary set of action buttons and resolves with
 * the `value` of whichever action was clicked, or null if dismissed via
 * the overlay/Escape. Always gives the user an explicit way out, unlike
 * window.confirm's OK/Cancel-only shape.
 */
function showModal({ title = "", message = "", actions = [] }) {
  return new Promise((resolve) => {
    const overlay = el("modalOverlay");
    const actionsEl = el("modalActions");

    el("modalTitle").textContent = title;
    el("modalMessage").textContent = message;
    actionsEl.innerHTML = "";

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.classList.add("hidden");
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    };

    const onOverlayClick = (e) => {
      if (e.target === overlay) finish(null);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") finish(null);
    };

    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.className = action.variant || "secondary";
      btn.addEventListener("click", () => finish(action.value));
      actionsEl.appendChild(btn);
    });

    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
    overlay.classList.remove("hidden");
  });
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
    showToast(`Device refresh failed: ${err.message}`);
  }
}

async function refreshStatus() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 5000);
  pollStatus();
}

async function rescanNow() {
  el("discoverBtn").textContent = "Scanning...";
  try {
    await api("/api/devices/rescan", { method: "POST" });
    await refreshDevices();
  } catch (err) {
    showToast(`Discovery failed: ${err.message}`);
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
    li.className = "media-item";

    // Only show progress once we actually have a saved position AND a
    // known duration -- without a duration we can't compute a percentage,
    // so leave the row exactly as it looks for a never-played title.
    let progressHtml = "";
    if (item.resume && item.resume.position > 0 && item.resume.duration > 0) {
      const pct = Math.min(
        100,
        (item.resume.position / item.resume.duration) * 100,
      );
      progressHtml = `
        <div class="progress-wrap">
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-time">${formatSeconds(item.resume.position)} / ${formatSeconds(item.resume.duration)}</span>
        </div>`;
    }

    li.innerHTML = `
      <div class="item-main">
        <span class="item-title">&#127916; ${item.title}</span>
        ${progressHtml}
      </div>`;
    li.addEventListener("click", () => playItem(item));
    list.appendChild(li);
  });
}

async function playItem(item) {
  if (!state.currentRendererUsn) {
    showToast("Pick a renderer first.");
    return;
  }

  let resume = false;
  if (item.resume && item.resume.position > 5) {
    const choice = await showModal({
      title: "Resume playback?",
      message: `"${item.title}" was last stopped at ${formatSeconds(item.resume.position)}.`,
      actions: [
        { label: "Cancel", value: "cancel", variant: "secondary" },
        { label: "Start over", value: "restart", variant: "secondary" },
        { label: "Resume", value: "resume", variant: "primary" },
      ],
    });

    if (choice === null || choice === "cancel") return; // user backed out entirely
    resume = choice === "resume";
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
  } catch (err) {
    showToast(`Playback failed: ${err.message}`);
  }
}

let statusTimer = null;

function showNowPlaying(title) {
  el("nowPlaying").classList.remove("hidden");
  el("npTitle").textContent = title;
  el("npResumeNote").textContent = "";
  state.reportedResumeAt = null;
}

async function pollStatus() {
  if (!state.currentRendererUsn) return;
  try {
    const s = await api(
      `/api/status?rendererUsn=${encodeURIComponent(state.currentRendererUsn)}`,
    );
    showNowPlaying(s.title);
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
  try {
    await api("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rendererUsn: state.currentRendererUsn,
        action: "pause",
      }),
    });
  } catch (err) {
    showToast(err.message);
  }
});
el("stopBtn").addEventListener("click", async () => {
  try {
    await api("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rendererUsn: state.currentRendererUsn,
        action: "stop",
      }),
    });
  } catch (err) {
    showToast(err.message);
  }
  el("nowPlaying").classList.add("hidden");
  clearInterval(statusTimer);
});

refreshDevices();
refreshStatus();
setInterval(refreshDevices, 8000); // pick up online/offline flips from the background scanner
