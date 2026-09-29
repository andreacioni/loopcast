import { formatSeconds, resumeProgress } from "../utils";

// Only renders once we have a saved position AND a known duration --
// without a duration we can't compute a percentage, so a never-played
// or duration-less title renders nothing here.
export function ProgressBar({ resume }) {
  const progress = resumeProgress(resume);
  if (!progress) return null;

  return (
    <div className="progress-wrap">
      <div className="progress-track">
        <div
          className={`progress-fill${progress.isComplete ? " progress-complete" : ""}`}
          style={{ width: `${progress.pct}%` }}
        />
      </div>
      <span className="progress-time">
        {formatSeconds(resume.position)} / {formatSeconds(resume.duration)}
      </span>
    </div>
  );
}
