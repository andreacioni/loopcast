import { useCallback, useEffect, useState } from "react";
import { getStatus } from "../api";
import { formatSeconds } from "../utils";

export function useStatusPolling(rendererUsn) {
  const [status, setStatus] = useState(null); // { title, position, duration }
  const [resumeNote, setResumeNote] = useState("");
  const [visible, setVisible] = useState(false);

  const poll = useCallback(async () => {
    if (!rendererUsn) return;
    try {
      const s = await getStatus(rendererUsn);
      if (s.state === "STOPPED") {
        setVisible(false);
      } else {
        setVisible(true);
      }
      setStatus(s);
      // Matches the original: the note is recomputed from the latest
      // lastResumeAttempt on every poll tick, not shown only once.
      setResumeNote("");

      if (s.lastResumeAttempt) {
        if (s.lastResumeAttempt.applied) {
          setResumeNote(
            `Resumed at ${formatSeconds(s.lastResumeAttempt.requestedSeconds)} (${s.lastResumeAttempt.unit})`,
          );
        } else {
          const snap = s.lastResumeAttempt.transportSnapshot;
          const detail = snap
            ? ` [renderer state: ${snap.transportState}, duration: ${snap.mediaDuration}]`
            : "";
          setResumeNote(
            `Could not resume (${s.lastResumeAttempt.error || "unknown error"}) — playing from the start${detail}`,
          );
        }
      }
    } catch {
      // renderer may have dropped off the network -- ignore transient errors
    }
  }, [rendererUsn]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  const hide = useCallback(() => {
    setVisible(false);
    setStatus(null);
    setResumeNote("");
  }, []);

  return { status, setStatus, resumeNote, visible, hide };
}
