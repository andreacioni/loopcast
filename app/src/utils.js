export function formatSeconds(s) {
  if (!s && s !== 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec]
    .map((n, i) => (i === 0 && n === 0 ? null : String(n).padStart(2, "0")))
    .filter(Boolean)
    .join(":");
}

// Returns { pct, isComplete } from a resume object, or null if there's
// nothing worth showing a progress bar for.
export function resumeProgress(resume) {
  if (!resume || !(resume.position > 0) || !(resume.duration > 0)) return null;
  const pct = Math.min(100, (resume.position / resume.duration) * 100);
  return { pct, isComplete: pct > 95 };
}
