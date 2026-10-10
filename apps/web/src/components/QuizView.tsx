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
import { useCallback, useEffect, useMemo, useState } from "react";

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

  const go = useCallback(
    (delta: number) =>
      setIndex((i) => Math.min(Math.max(i + delta, 0), total - 1)),
    [total]
  );

  const choose = useCallback(
    (option: number) => {
      if (submitted) return;
      setAnswers((a) => ({ ...a, [index]: option }));
    },
    [index, submitted]
  );

  const submit = useCallback(() => {
    if (remaining > 0) return;
    setSubmitted(true);
    window.scrollTo({ top: 0 });
    if (onSubmit) {
      setSaveFailed(false);
      onSubmit(questions.map((_, i) => answers[i])).catch(() => setSaveFailed(true));
    }
  }, [remaining, onSubmit, questions, answers]);

  const retake = useCallback(() => {
    setAnswers({});
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
          <p className="quiz-score-line">
            {score} / {total}
          </p>
          <p className="muted">
            {percent}% correct.{" "}
            {score === total
              ? "Every one. Come back to it tomorrow rather than now. That is what makes it stick."
              : `${total - score} to go back over below.`}
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
              <h2>Worth another look</h2>
              <ul>
                {weakSpots
                  .filter((w) => w.weak)
                  .map((w) => (
                    <li key={w.section}>
                      <span>{w.section}</span>
                      <span className="muted">
                        {w.correct}/{w.asked}
                      </span>
                    </li>
                  ))}
              </ul>
              {onPractise && (
                <button onClick={onPractise}>Practise these</button>
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
              onClick={() => setIndex(i)}
            />
          );
        })}
      </div>

      <div className="quiz-card">
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
              onClick={() => choose(j)}
              title={`Press ${j + 1}`}
            >
              <span className="quiz-letter">{LETTERS[j]}</span>
              <span className="quiz-option-text">{formatChem(option)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="quiz-controls">
        <button
          className="link-button"
          onClick={() => go(-1)}
          disabled={index === 0}
        >
          <IconPrev />
          Previous
        </button>
        {index < total - 1 ? (
          <button className="link-button" onClick={() => go(1)}>
            Next
            <IconNext />
          </button>
        ) : (
          <span />
        )}
        <button onClick={submit} disabled={remaining > 0}>
          {remaining > 0 ? `Submit (${remaining} left)` : "Submit"}
        </button>
      </div>
    </div>
  );
}
