import { useCallback, useRef, useState } from "react";
import { Header } from "./components/Header";
import { DeviceBar } from "./components/DeviceBar";
import { ContinueWatching } from "./components/ContinueWatching";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { ItemList } from "./components/ItemList";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { useDevices } from "./hooks/useDevices";
import { useStatusPolling } from "./hooks/useStatusPolling";
import { useToast } from "./hooks/useToast";
import { useConfirm } from "./hooks/useConfirm";
import { getFolder, getHome, playMedia, controlRenderer } from "./api";
import { formatSeconds } from "./utils";

const ROOT_CRUMB = { id: "0", title: "Root" };

export default function App() {
  const showToast = useToast();
  const confirm = useConfirm();

  const [path, setPath] = useState([ROOT_CRUMB]);
  const [containers, setContainers] = useState([]);
  const [items, setItems] = useState([]);
  const [cards, setCards] = useState([]);

  // Kept for building the "rest of this folder" queue when an item is played.
  const currentItemsRef = useRef([]);

  const loadFolder = useCallback(async (serverUsn, objectId) => {
    if (!serverUsn) return;
    try {
      const data = await getFolder(serverUsn, objectId);
      currentItemsRef.current = data.items;
      setContainers(data.containers);
      setItems(data.items);
    } catch (err) {
      showToast(`Failed to load folder: ${err.message}`);
    }
  }, [showToast]);

  const loadHome = useCallback(async (serverUsn) => {
    if (!serverUsn) return;
    try {
      const { cards: newCards } = await getHome(serverUsn);
      setCards(newCards);
    } catch {
      // Non-critical -- just hide the carousel if it can't be built.
      setCards([]);
    }
  }, []);

  const handleFirstServer = useCallback(
    (usn) => {
      setPath([ROOT_CRUMB]);
      loadFolder(usn, "0");
      loadHome(usn);
    },
    [loadFolder, loadHome],
  );

  const {
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
  } = useDevices({ onFirstServer: handleFirstServer });

  const { status, setStatus, resumeNote, visible, hide } = useStatusPolling(rendererUsn);

  const handleServerChange = (usn) => {
    setServerUsn(usn);
    setPath([ROOT_CRUMB]);
    loadFolder(usn, "0");
    loadHome(usn);
  };

  const openFolder = (container) => {
    const nextPath = [...path, { id: container.id, title: container.title }];
    setPath(nextPath);
    loadFolder(serverUsn, container.id);
  };

  const navigateBreadcrumb = (idx) => {
    const nextPath = path.slice(0, idx + 1);
    setPath(nextPath);
    loadFolder(serverUsn, nextPath[idx].id);
  };

  const play = useCallback(
    async ({ item, resume, queue }) => {
      if (!rendererUsn) {
        showToast("Pick a renderer first.");
        return;
      }
      try {
        await playMedia({ rendererUsn, item, resume, queue });
      } catch (err) {
        showToast(`Playback failed: ${err.message}`);
      }
    },
    [rendererUsn, showToast],
  );

  const playItem = useCallback(
    async (item) => {
      if (!rendererUsn) {
        showToast("Pick a renderer first.");
        return;
      }

      let resume = false;
      if (item.resume && item.resume.position > 5) {
        const choice = await confirm({
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

      // Queue the rest of the folder (alphabetical order) after this item so
      // playback continues automatically once it finishes.
      const sortedSiblings = [...currentItemsRef.current].sort((a, b) =>
        (a.title || "").localeCompare(b.title || ""),
      );
      const currentIdx = sortedSiblings.findIndex((i) => i.id === item.id);
      const queue = currentIdx === -1 ? [] : sortedSiblings.slice(currentIdx + 1);

      await play({ item, resume, queue });
    },
    [rendererUsn, showToast, confirm, play],
  );

  const resumeCard = useCallback(
    (card) => play({ item: card.item, resume: true, queue: card.queue }),
    [play],
  );

  const playNextInQueue = useCallback(
    (card) => {
      const [next, ...rest] = card.queue;
      play({ item: next, resume: false, queue: rest });
    },
    [play],
  );

  const handlePlayPause = async () => {
    if(!["PLAYING", "PAUSED", "PAUSED_PLAYBACK"].includes(status?.state)) {
      throw new Error("Cannot play/pause when renderer is not in a valid state.");
    }
    
    const isPlaying = status?.state === "PLAYING";
    const action = isPlaying ? "pause" : "resume-playback";
    
    try {
      await controlRenderer(rendererUsn, action);
      setStatus((prev) => ({ ...prev, state: isPlaying ? "PAUSED_PLAYBACK" : "PLAYING" }));
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleStop = async () => {
    try {
      await controlRenderer(rendererUsn, "stop");
      setStatus((prev) => ({ ...prev, state: "STOPPED" }));
    } catch (err) {
      showToast(err.message);
    }
    hide();
  };

  return (
    <>
      <Header
        discoveryEnabled={discoveryEnabled}
        discoveryRemaining={discoveryRemaining}
        discoveryStarting={discoveryStarting}
        onToggleDiscovery={toggleDiscovery}
      />

      <main>
        <DeviceBar
          servers={servers}
          renderers={renderers}
          serverUsn={serverUsn}
          rendererUsn={rendererUsn}
          onServerChange={handleServerChange}
          onRendererChange={setRendererUsn}
        />

        <ContinueWatching
          cards={cards}
          onResume={resumeCard}
          onPlayNext={playNextInQueue}
        />

        <Breadcrumbs path={path} onNavigate={navigateBreadcrumb} />

        <ItemList
          containers={containers}
          items={items}
          onOpenFolder={openFolder}
          onPlayItem={playItem}
        />
      </main>

      <NowPlayingBar
        visible={visible}
        status={status}
        resumeNote={resumeNote}
        onPlayPause={handlePlayPause}
        onStop={handleStop}
      />
    </>
  );
}
