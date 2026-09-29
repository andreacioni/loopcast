function statusLabel(d) {
  return d.status === "online" ? "" : " (offline)";
}

export function DeviceBar({
  servers,
  renderers,
  serverUsn,
  rendererUsn,
  onServerChange,
  onRendererChange,
}) {
  return (
    <section id="deviceBar">
      <label>
        Library
        <select
          id="serverSelect"
          value={serverUsn || ""}
          onChange={(e) => onServerChange(e.target.value)}
        >
          {servers.map((s) => (
            <option key={s.usn} value={s.usn}>
              {s.friendlyName}
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Play on
        <select
          id="rendererSelect"
          value={rendererUsn || ""}
          onChange={(e) => onRendererChange(e.target.value)}
        >
          {renderers.map((r) => (
            <option key={r.usn} value={r.usn}>
              {r.friendlyName}
              {statusLabel(r)}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
