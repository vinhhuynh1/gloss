/**
 * The generated quiz: answer every question, then submit for the score.
 *
 * Feedback only at the end, by design. Showing right or wrong after each
 * question turns the next one into a reaction to the last; holding it back
 * makes the score a measure of what the reader knew going in. Answers can be
 * changed freely until Submit, and nothing on the page hints at the answer
 * before it — not even the citation, because a filename can give it away.
 *
 * Submitting saves the attempt through `onSubmit`, in the background: the
 * score is shown straight away from the answers in hand, and a save that
 * fails says so in one line rather than taking the score away. Each submit
 * is its own attempt, retakes included; the API keeps the latest per quiz for
 * weak spots.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { formatChem } from "../lib/chem";
import type { Quiz, QuizQuestion, WeakSpot } from "../lib/types";
import {
  IconAccept,
  IconDismiss,
  IconNext,
  IconPrev,
  IconRestart,
} from "./Icon";

const LETTERS = ["A", "B", "C", "D"];

// How long a fresh pick stays on screen before the next question slides in.
// Long enough to see the choice land, short enough not to feel like waiting.
const ADVANCE_MS = 340;

/** A custom property for a staggered entrance: the n-th item waits n steps. */
const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

/** The score as a ring that fills to the result. */
function ScoreRing({ score, total }: { score: number; total: number }) {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const fraction = total ? score / total : 0;
  return (
    <div
      className="quiz-ring"
      style={
        {
          "--circumference": circumference,
          "--target": circumference * (1 - fraction),
        } as CSSProperties
      }
    >
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="quiz-ring-track" cx="60" cy="60" r={r} />
        <circle className="quiz-ring-fill" cx="60" cy="60" r={r} />
      </svg>
      <p className="quiz-score-line">
        <span>
          {score}
          <span className="quiz-score-total">/{total}</span>
        </span>
      </p>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      className="icon-button"
      aria-label="Close quiz"
      title="Close (Esc)"
      onClick={onClose}
    >
      <IconDismiss />
    </button>
  );
}

function Source({ q }: { q: QuizQuestion }) {
  if (!q.source_filename) return null;
  return (
    <details className="quiz-source">
      <summary>
        {q.source_filename}
        {q.source_page_ref && `, ${q.source_page_ref}`}
      </summary>
      <p>{q.source_excerpt}</p>
    </details>
  );
}

export default function QuizView({
  quiz,
  generatedAt,
  onClose,
  onSubmit,
  weakSpots = [],
  onPractise,
}: {
  quiz: Quiz;
  generatedAt: string | null;
  onClose: () => void;
  onSubmit?: (answers: number[]) => Promise<void>;
  weakSpots?: WeakSpot[];
  onPractise?: () => void;
}) {
  const questions = quiz.questions;
  const total = questions.length;
  const [index, setIndex] = useState(0);
  // Which way the last move went, so the next question slides in from the
  // side it lives on rather than always from the same edge.
  const [dir, setDir] = useState<1 | -1>(1);
  const advanceTimer = useRef<number | undefined>(undefined);
  // Question index -> chosen option index. Sparse: a question not in here has
  // not been answered yet, which is what keeps Submit locked.
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const remaining = total - Object.keys(answers).length;
  const score = useMemo(
    () =>
      questions.reduce(
        (n, q, i) => n + (answers[i] === q.correct_index ? 1 : 0),
        0
      ),
    [questions, answers]
  );

  const jump = useCallback(
    (to: number) => {
      window.clearTimeout(advanceTimer.current);
      const next = Math.min(Math.max(to, 0), total - 1);
      setIndex((i) => {
        if (next !== i) setDir(next > i ? 1 : -1);
        return next;
      });
    },
    [total]
  );

  const go = useCallback((delta: number) => jump(index + delta), [jump, index]);

  // A first pick on a question moves on by itself; changing an answer that
  // was already there does not, because that is someone reconsidering.
  const choose = useCallback(
    (option: number) => {
      if (submitted) return;
      const fresh = answers[index] === undefined;
      setAnswers((a) => ({ ...a, [index]: option }));
      window.clearTimeout(advanceTimer.current);
      if (fresh && index < total - 1) {
        advanceTimer.current = window.setTimeout(() => jump(index + 1), ADVANCE_MS);
      }
    },
    [answers, index, submitted, total, jump]
  );

  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);

  const submit = useCallback(() => {
    if (remaining > 0) return;
    window.clearTimeout(advanceTimer.current);
    setSubmitted(true);
    window.scrollTo({ top: 0 });
    if (onSubmit) {
      setSaveFailed(false);
      onSubmit(questions.map((_, i) => answers[i])).catch(() => setSaveFailed(true));
    }
  }, [remaining, onSubmit, questions, answers]);

  const retake = useCallback(() => {
    setAnswers({});
    setDir(1);
    setIndex(0);
    setSubmitted(false);
    window.scrollTo({ top: 0 });
  }, []);

  // 1-4 pick an option and the arrows move, because a 25-question quiz
  // clicked through with a mouse is a quiz that stops getting taken.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      // Ctrl+1 switches browser tabs; it must not also pick answer A.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (submitted) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= LETTERS.length) choose(n - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitted, go, choose, onClose]);

  const header = (
    <>
      <div className="quiz-actions">
        <span />
        <CloseButton onClose={onClose} />
      </div>
      <h1 className="quiz-title">{quiz.title}</h1>
      {generatedAt && (
        <p className="muted quiz-generated">
          Generated {new Date(generatedAt).toLocaleString()} from this study
          space&apos;s notes and sources.
        </p>
      )}
    </>
  );

  if (total === 0) {
    return (
      <div className="quiz">
        {header}
        <p className="muted">This quiz came back empty.</p>
      </div>
    );
  }

  if (submitted) {
    const percent = Math.round((score / total) * 100);
    return (
      <div className="quiz">
        {header}
        <div className="quiz-score">
          <ScoreRing score={score} total={total} />
          <p className="muted quiz-score-note">
            {percent}% correct.{" "}
            {score === total
              ? "Full marks."
              : `${total - score} to review below.`}
          </p>
          {saveFailed && (
            <p className="muted">This result wasn&apos;t saved.</p>
          )}
          <div className="quiz-score-actions">
            <button onClick={retake}>
              <IconRestart />
              Retake
            </button>
          </div>
          {weakSpots.some((w) => w.weak) && (
            <div className="quiz-weak">
              <h2>Weak sections</h2>
              <ul>
                {weakSpots
                  .filter((w) => w.weak)
                  .map((w, i) => (
                    <li key={w.section} style={stagger(i)}>
                      <span>{w.section}</span>
                      <span className="muted">
                        {w.correct}/{w.asked}
                      </span>
                    </li>
                  ))}
              </ul>
              {onPractise && (
                <button onClick={onPractise}>Practise weak spots</button>
              )}
            </div>
          )}
        </div>

        <ol className="quiz-review">
          {questions.map((q, i) => {
            const chosen = answers[i];
            const right = chosen === q.correct_index;
            return (
              <li
                key={i}
                className={`quiz-review-item ${right ? "is-right" : "is-wrong"}`}
                style={stagger(i)}
              >
                <p className="quiz-question">{formatChem(q.question)}</p>
                <ul className="quiz-options is-review">
                  {q.options.map((option, j) => {
                    const isCorrect = j === q.correct_index;
                    const isWrongPick = j === chosen && !right;
                    return (
                      <li
                        key={j}
                        className={[
                          "quiz-option",
                          isCorrect ? "is-correct" : "",
                          isWrongPick ? "is-wrong-pick" : "",
                        ].join(" ")}
                      >
                        <span className="quiz-letter">{LETTERS[j]}</span>
                        <span className="quiz-option-text">
                          {formatChem(option)}
                        </span>
                        {j === chosen && (
                          <span className="quiz-tag">Your answer</span>
                        )}
                        {isCorrect && (
                          <IconAccept className="quiz-mark" aria-label="Correct answer" />
                        )}
                        {isWrongPick && (
                          <IconDismiss className="quiz-mark" aria-label="Wrong answer" />
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="quiz-explanation">{formatChem(q.explanation)}</p>
                <Source q={q} />
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  const q = questions[index];
  return (
    <div className="quiz">
      {header}

      <div className="quiz-dots" aria-label="Questions">
        {questions.map((_, i) => {
          const answered = answers[i] !== undefined;
          return (
            <button
              key={i}
              className={[
                "quiz-dot",
                i === index ? "is-current" : "",
                answered ? "is-answered" : "",
              ].join(" ")}
              aria-label={`Question ${i + 1}${answered ? ", answered" : ""}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => jump(i)}
            />
          );
        })}
      </div>

      <div className="quiz-card">
        {/* Keyed on the question, so each one arrives rather than the text
            swapping in place, and from the side it lives on. */}
        <div
          key={index}
          className={`quiz-stage ${dir > 0 ? "from-next" : "from-prev"}`}
        >
          <p className="muted quiz-count">
            Question {index + 1} of {total}
          </p>
          <p className="quiz-question">{formatChem(q.question)}</p>
          <div className="quiz-options" role="radiogroup" aria-label="Options">
            {q.options.map((option, j) => (
              <button
                key={j}
                role="radio"
                aria-checked={answers[index] === j}
                className={`quiz-option ${answers[index] === j ? "is-selected" : ""}`}
                style={stagger(j)}
                onClick={() => choose(j)}
                title={`Press ${j + 1}`}
              >
                <span className="quiz-letter">{LETTERS[j]}</span>
                <span className="quiz-option-text">{formatChem(option)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="quiz-controls">
        <div className="quiz-pager" role="group" aria-label="Move between questions">
          <button
            className="quiz-step"
            onClick={() => go(-1)}
            disabled={index === 0}
            aria-label="Previous question"
            title="Previous question (Left arrow)"
          >
            <IconPrev />
          </button>
          <button
            className="quiz-step"
            onClick={() => go(1)}
            disabled={index === total - 1}
            aria-label="Next question"
            title="Next question (Right arrow)"
          >
            <IconNext />
          </button>
        </div>
        <p className="quiz-keys" aria-hidden="true">
          <kbd>1</kbd>
          <kbd>2</kbd>
          <kbd>3</kbd>
          <kbd>4</kbd> to answer
        </p>
        <button
          className={`quiz-submit${remaining === 0 ? " is-ready" : ""}`}
          onClick={submit}
          disabled={remaining > 0}
          style={{ "--progress": (total - remaining) / total } as CSSProperties}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
