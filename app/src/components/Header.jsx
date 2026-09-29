export function Header({
  discoveryEnabled,
  discoveryRemaining,
  discoveryStarting,
  onToggleDiscovery,
}) {
  const label = discoveryStarting
    ? "Starting..."
    : discoveryEnabled
      ? `Allow join (${discoveryRemaining}s)`
      : "Enable discovery";

  return (
    <header>
      <h1>LoopCast</h1>
      <button
        id="discoverBtn"
        className={discoveryEnabled ? "active" : ""}
        onClick={onToggleDiscovery}
      >
        {label}
      </button>
    </header>
  );
}
