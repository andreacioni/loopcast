import { useCallback, useEffect, useRef, useState } from "react";
import { getDevices, setDiscovery } from "../api";
import { useToast } from "./useToast";

// Mirrors the original app's device-select behaviour: preserve the current
// selection across refreshes, only fall back to "first device" if nothing
// was selected yet or the selection vanished.
function reconcileSelection(list, prevUsn) {
  const stillThere = list.some((d) => d.usn === prevUsn);
  return stillThere ? prevUsn : list[0]?.usn || null;
}

export function useDevices({ onFirstServer }) {
  const [servers, setServers] = useState([]);
  const [renderers, setRenderers] = useState([]);
  const [serverUsn, setServerUsn] = useState(null);
  const [rendererUsn, setRendererUsn] = useState(null);
  const [discoveryEnabled, setDiscoveryEnabled] = useState(false);
  const [discoveryRemaining, setDiscoveryRemaining] = useState(0);
  const [discoveryStarting, setDiscoveryStarting] = useState(false);

  const showToast = useToast();
  const discoveryTimerRef = useRef(null);
  const serverUsnRef = useRef(serverUsn);
  const rendererUsnRef = useRef(rendererUsn);
  const onFirstServerRef = useRef(onFirstServer);
  serverUsnRef.current = serverUsn;
  rendererUsnRef.current = rendererUsn;
  onFirstServerRef.current = onFirstServer;

  const syncDiscoveryUi = useCallback((enabled, remainingSeconds = 0) => {
    if (!enabled || remainingSeconds <= 0) {
      clearInterval(discoveryTimerRef.current);
      discoveryTimerRef.current = null;
      setDiscoveryEnabled(false);
      setDiscoveryRemaining(0);
      return;
    }

    setDiscoveryEnabled(true);
    setDiscoveryRemaining(remainingSeconds);

    if (!discoveryTimerRef.current) {
      discoveryTimerRef.current = setInterval(() => {
        setDiscoveryRemaining((prev) => {
          if (prev <= 1) {
            clearInterval(discoveryTimerRef.current);
            discoveryTimerRef.current = null;
            setDiscoveryEnabled(false);
            refreshDevices();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const { servers: newServers, renderers: newRenderers, discovery: disc } =
        await getDevices();
      const hadNoServer = !serverUsnRef.current;

      setServers(newServers);
      setRenderers(newRenderers);
      setServerUsn(reconcileSelection(newServers, serverUsnRef.current));
      setRendererUsn(reconcileSelection(newRenderers, rendererUsnRef.current));

      if (disc) syncDiscoveryUi(disc.enabled, disc.remainingSeconds);

      const gotFirstServer =
        hadNoServer && reconcileSelection(newServers, serverUsnRef.current);
      if (gotFirstServer) onFirstServerRef.current?.(gotFirstServer);
    } catch (err) {
      showToast(`Device refresh failed: ${err.message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncDiscoveryUi, showToast]);

  const toggleDiscovery = useCallback(async () => {
    if (discoveryEnabled) {
      try {
        await setDiscovery(false);
        syncDiscoveryUi(false, 0);
        showToast("Discovery mode cancelled", "info");
        await refreshDevices();
      } catch (err) {
        showToast(`Failed to cancel discovery: ${err.message}`);
      }
    } else {
      try {
        setDiscoveryStarting(true);
        const res = await setDiscovery(true, 60000);
        const remaining = res.discovery?.remainingSeconds || 60;
        syncDiscoveryUi(true, remaining);
        showToast("Discovery enabled for 60s", "info");
        setTimeout(refreshDevices, 1500);
        setTimeout(refreshDevices, 4500);
      } catch (err) {
        showToast(`Failed to enable discovery: ${err.message}`);
      } finally {
        setDiscoveryStarting(false);
      }
    }
  }, [discoveryEnabled, syncDiscoveryUi, showToast, refreshDevices]);

  useEffect(() => {
    refreshDevices();
    const interval = setInterval(refreshDevices, 8000);
    return () => {
      clearInterval(interval);
      clearInterval(discoveryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    servers,
    renderers,
    serverUsn,
    rendererUsn,
    setServerUsn,
    setRendererUsn,
    discoveryEnabled,
    discoveryRemaining,
    discoveryStarting,
    toggleDiscovery,
  };
}
