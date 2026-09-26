/**
 * The generated deck: one card at a time, and a score at the end.
 *
 * Two modes, because they answer different questions. **Review** steps
 * through the deck and shows the citation with each answer — it is for
 * learning the material and checking the card is right. **Quiz** hides the
 * citation until you have graded yourself and keeps a score, because a deck
 * you have read is not a deck you know.
 *
 * Self-grading rather than typed answers. The backs are prose from the source
 * material, so string comparison would mark "in the cytosol" wrong against
 * "cytosol" and teach the reader to write for the grader instead of for
 * themselves.
 *
 * Unlike the study guide there is no print view. A deck is reviewed by being
 * tested against, and a sheet of questions with their answers printed
 * underneath is a worse study guide, not a better deck.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Deck } from "../lib/types";
import { IconNext, IconPrev, IconRestart } from "./Icon";

type Mode = "review" | "quiz";

export default function FlashcardsView({
  deck,
  generatedAt,
  onClose,
}: {
  deck: Deck;
  generatedAt: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("review");
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // Card index -> did the reader say they knew it. Sparse: a card not in here
  // has not been graded yet, which is different from having got it wrong.
  const [graded, setGraded] = useState<Record<number, boolean>>({});

  const cards = deck.cards;
  const card = cards[index];
  const done = mode === "quiz" && Object.keys(graded).length === cards.length;

  const score = useMemo(
    () => Object.values(graded).filter(Boolean).length,
    [graded]
  );

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(Math.max(i + delta, 0), cards.length - 1));
      setRevealed(false);
    },
    [cards.length]
  );

  const grade = useCallback(
    (knew: boolean) => {
      setGraded((g) => ({ ...g, [index]: knew }));
      if (index < cards.length - 1) go(1);
    },
    [index, cards.length, go]
  );

  function restart(next: Mode) {
    setMode(next);
    setIndex(0);
    setRevealed(false);
    setGraded({});
  }

  // Keyboard review, because clicking through forty cards with a mouse is
  // how a deck stops getting used. Space reveals then advances, which is the
  // rhythm every flashcard app has trained people into.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal a key from someone typing — this view has no inputs of
      // its own today, but it will the first time a "add your own card"
      // field appears.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else if (mode === "review") go(1);
        return;
      }
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (mode === "quiz" && revealed) {
        if (e.key === "1" || e.key.toLowerCase() === "y") grade(true);
        if (e.key === "2" || e.key.toLowerCase() === "n") grade(false);
      }
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, mode, go, grade, onClose]);

  if (cards.length === 0) {
    return (
      <div className="flashcards">
        <div className="flashcards-actions">
          <button className="link-button" onClick={onClose}>
            Back to notes
          </button>
        </div>
        <p className="muted">This deck came back empty.</p>
      </div>
    );
  }

  return (
    <div className="flashcards">
      <div className="flashcards-actions">
        <div className="flashcards-modes" role="tablist" aria-label="Deck mode">
          <button
            role="tab"
            aria-selected={mode === "review"}
            className={mode === "review" ? "is-active" : ""}
            onClick={() => restart("review")}
          >
            Review
          </button>
          <button
            role="tab"
            aria-selected={mode === "quiz"}
            className={mode === "quiz" ? "is-active" : ""}
            onClick={() => restart("quiz")}
          >
            Quiz
          </button>
        </div>
        <button className="link-button" onClick={onClose}>
          Back to notes
        </button>
      </div>

      <h1 className="flashcards-title">{deck.title}</h1>
      {generatedAt && (
        <p className="muted flashcards-generated">
          Generated {new Date(generatedAt).toLocaleString()} from this study
          space&apos;s notes and sources.
        </p>
      )}

      {done ? (
        <div className="flashcards-score">
          <p className="flashcards-score-line">
            {score} / {cards.length}
          </p>
          <p className="muted">
            {score === cards.length
              ? "Every card. Come back to it tomorrow rather than now — that is what makes it stick."
              : `${cards.length - score} to go back over.`}
          </p>
          <div className="flashcards-score-actions">
            <button onClick={() => restart("quiz")}>
              <IconRestart />
              Run it again
            </button>
            <button className="link-button" onClick={() => restart("review")}>
              Review the deck
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flashcard" onClick={() => setRevealed(true)}>
            <p className="flashcard-front">{card.front}</p>

            {revealed ? (
              <>
                <p className="flashcard-back">{card.back}</p>
                {/* The citation is the point of the whole product: the reader
                    can check the answer rather than trusting it. Hidden until
                    revealed in quiz mode, because the filename alone can give
                    the answer away. */}
                {card.source_filename && (
                  <details className="flashcard-source">
                    <summary>
                      {card.source_filename}
                      {card.source_page_ref && `, ${card.source_page_ref}`}
                    </summary>
                    <p>{card.source_excerpt}</p>
                  </details>
                )}
              </>
            ) : (
              <p className="muted flashcard-hint">
                Click, or press Space, to see the answer.
              </p>
            )}
          </div>

          <div className="flashcards-controls">
            <button
              className="link-button"
              onClick={() => go(-1)}
              disabled={index === 0}
            >
              <IconPrev />
              Previous
            </button>

            <span className="muted flashcards-position">
              {index + 1} / {cards.length}
              {mode === "quiz" && ` · ${score} known`}
            </span>

            {mode === "quiz" && revealed ? (
              <span className="flashcards-grade">
                <button onClick={() => grade(true)} title="Press 1 or Y">
                  Knew it
                </button>
                <button onClick={() => grade(false)} title="Press 2 or N">
                  Didn&apos;t
                </button>
              </span>
            ) : (
              <button
                className="link-button"
                onClick={() => go(1)}
                disabled={index === cards.length - 1}
              >
                Next
                <IconNext />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
