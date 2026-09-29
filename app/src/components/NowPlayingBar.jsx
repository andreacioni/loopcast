import { CircleStop, Pause, Play } from "lucide-react";
import { formatSeconds } from "../utils";

export function NowPlayingBar({ visible, status, resumeNote, onPlayPause, onStop }) {
  if (!visible || !status) return null;

  const pct =
    status.duration > 0
      ? Math.min(100, (status.position / status.duration) * 100)
      : 0;

  
  const isPlaying = status.state === "PLAYING";

  return (
    <footer id="nowPlaying">
      <div id="npProgressTrack">
        <div id="npProgressFill" style={{ width: `${pct}%` }} />
      </div>
      <div id="npContent">
<div id="npInfo">
        <span id="npTitle">{status.title}</span>
        <p id="npResumeNote">{resumeNote}</p>
      </div>
      <div id="npControls">
        <button
          id="playPauseBtn"
          title="Pause / Play"
          aria-label="Pause / Play"
          onClick={onPlayPause}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button id="stopBtn" title="Stop" aria-label="Stop" onClick={onStop}>
          <CircleStop size={18} />
        </button>
        <span id="npPosition">
          {formatSeconds(status.position)} / {formatSeconds(status.duration)}
        </span>
      </div>
      </div>
      
    </footer>
  );
}
