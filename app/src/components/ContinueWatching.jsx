import { Film, Folder, Forward } from "lucide-react";
import { ProgressBar } from "./ProgressBar";
import { resumeProgress } from "../utils";

function CwCard({ card, onResume, onPlayNext }) {
  const { item } = card;
  const progress = resumeProgress(item.resume);
  const showNextBtn = progress?.isComplete && card.queue.length > 0;

  return (
    <div className="cw-card" onClick={() => onResume(card)}>
      <span className="cw-folder"><Folder size={14} /> {card.folderTitle}</span>
      <span className="cw-title"><Film size={15} /> {item.title}</span>
      <ProgressBar resume={item.resume} />
      {card.queue.length > 0 && (
        <div className="cw-bottom-row">
          <span className="cw-queue-note">+{card.queue.length} up next</span>
          {showNextBtn && (
            <button
              className="cw-next-btn"
              title="Play next"
              aria-label="Play next"
              onClick={(e) => {
                e.stopPropagation();
                onPlayNext(card);
              }}
            >
              Next <Forward size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ContinueWatching({ cards, onResume, onPlayNext }) {
  if (!cards.length) return null;

  return (
    <section id="continueWatching">
      <h2>Continue watching</h2>
      <div id="continueWatchingTrack">
        {cards.map((card) => (
          <CwCard
            key={card.item.id}
            card={card}
            onResume={onResume}
            onPlayNext={onPlayNext}
          />
        ))}
      </div>
    </section>
  );
}
