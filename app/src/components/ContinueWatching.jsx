import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Film, Folder, Forward } from "lucide-react";
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
  const trackRef = useRef(null);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  const updateScrollState = () => {
    const track = trackRef.current;
    if (!track) return;
    setCanScrollPrev(track.scrollLeft > 1);
    setCanScrollNext(
      track.scrollLeft + track.clientWidth < track.scrollWidth - 1
    );
  };

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    updateScrollState();

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(track);
    track.addEventListener("scroll", updateScrollState);
    window.addEventListener("resize", updateScrollState);

    return () => {
      resizeObserver.disconnect();
      track.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [cards]);

  const scrollByAmount = (direction) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({
      left: direction * track.clientWidth * 0.8,
      behavior: "smooth",
    });
  };

  if (!cards.length) return null;

  return (
    <section id="continueWatching">
      <h2>Continue watching</h2>
      <div className="cw-carousel">
        {canScrollPrev && (
          <div className="cw-scroll-zone cw-scroll-zone-prev">
            <button
              type="button"
              className="cw-scroll-btn"
              title="Scroll left"
              aria-label="Scroll left"
              onClick={() => scrollByAmount(-1)}
            >
              <ChevronLeft size={22} />
            </button>
          </div>
        )}
        <div id="continueWatchingTrack" ref={trackRef}>
          {cards.map((card) => (
            <CwCard
              key={card.item.id}
              card={card}
              onResume={onResume}
              onPlayNext={onPlayNext}
            />
          ))}
        </div>
        {canScrollNext && (
          <div className="cw-scroll-zone cw-scroll-zone-next">
            <button
              type="button"
              className="cw-scroll-btn"
              title="Scroll right"
              aria-label="Scroll right"
              onClick={() => scrollByAmount(1)}
            >
              <ChevronRight size={22} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
