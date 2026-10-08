# Replace flashcards with a multiple-choice quiz

Date: 2026-10-08
Status: approved in chat, awaiting spec review

## Goal

Remove flashcards from Gloss entirely and replace them with a generated
multiple-choice quiz. The quiz is built from a document's notes and grounded
in the study space's sources, the same way flashcards are today.

## Decisions (from the user)

| Question | Decision |
|---|---|
| Are results saved? | No. The score is shown at the end and lives only in the browser tab. No attempts table. |
| When is feedback shown? | Only at the end, after Submit. Nothing reveals right/wrong before that. |
| Existing flashcard decks | Deleted. `flashcard_sets` is dropped. |
| Quiz length | Scales with the notes: about one question per key idea, capped at 25. |
| Approach | Full rename to "quiz" in every layer; no flashcard code or names left behind. |

## Out of scope

- Saving scores, history, or per-question statistics.
- A study mode with per-question feedback.
- Letting the user choose the question count.
- Converting old decks into quizzes. They have no distractors, so they cannot be converted.
- Adding a test framework to the repo.

## Quiz shape

Stored in `quizzes.questions` (JSONB):

```json
{
  "title": "string",
  "questions": [
    {
      "question": "string",
      "options": ["string", "string", "string", "string"],
      "correct_index": 0,
      "explanation": "string",
      "source_chunk_id": "string",
      "source_filename": "string",
      "source_page_ref": "string",
      "source_excerpt": "string"
    }
  ]
}
```

The model returns `question`, `options`, `correct_index`, `explanation` and
`source_chunk_id`. The worker adds the `source_*` fields at write time, the
same denormalization flashcards and study guides use, so a citation still
resolves after the sources are re-chunked.

### Validation (worker, `_validate_quiz`)

A question is dropped when any of these is true:

- its `source_chunk_id` is not one of the chunks retrieved for this request
- `question` or `explanation` is empty after stripping
- `options` does not contain exactly 4 entries
- any option is empty after stripping, or two options are equal after stripping and ignoring case
- `correct_index` is not an integer from 0 to 3

Surviving questions are cut to `MAX_QUESTIONS = 25`. The title falls back to
`"Quiz"` when it is missing.

### Option shuffling

After validation the worker shuffles each question's options with
`random.shuffle` and remaps `correct_index` to the new position of the correct
option. This counters the model's habit of putting the right answer in the
same slot.

### Prompt (`QUIZ_SYSTEM_PROMPT`, `build_quiz_prompt`)

Replaces the flashcard prompt and keeps its grounding rules word for word:
cover the notes and not the wider subject, cite exactly one retrieved excerpt
per question, use no outside knowledge, and leave out anything no excerpt
supports. The guidance on writing questions:

- One idea per question. Prefer understanding over recognition.
- Exactly four options, exactly one of them correct.
- Distractors are plausible: common misconceptions, near-miss values, or
  related terms from the same material. No joke options, no "all of the
  above" or "none of the above".
- Options have similar length and grammatical form, so the answer cannot be
  spotted by its shape.
- The explanation says why the correct answer is right, in one or two
  sentences, drawn from the cited excerpt.
- About one question per key idea in the notes, at most 25.

## Database: `infra/migrations/014_quizzes.sql`

- `CREATE TABLE IF NOT EXISTS quizzes` with the same columns as
  `flashcard_sets` after 012 (`id`, `document_id` cascading on delete,
  `requested_by` cascading on delete, `notes`, `status`, `attempts`,
  `claimed_at`, `error`, `created_at`, `finished_at`, `progress`, `stage`),
  with `questions JSONB` in place of `cards`.
- Indexes: `quizzes_pending_idx` (partial, `status = 'pending'`),
  `quizzes_processing_idx` (partial, `status = 'processing'`),
  `quizzes_document_created_idx` on `(document_id, created_at DESC)`.
- `ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY`.
- `DROP TABLE IF EXISTS flashcard_sets`.

`infra/supabase/011_lockdown.sql`: change the `flashcard_sets` line to
`ALTER TABLE IF EXISTS`, and add `ALTER TABLE IF EXISTS public.quizzes ENABLE
ROW LEVEL SECURITY`, so re-running it after 014 does not fail.

`infra/README.md`: add the 014 step alongside the existing migration steps.

Migrations 007 and 012 stay as they are. On a fresh database they still run
in order, and 014 drops what they created.

## Worker (`apps/agent-worker`)

- Delete `flashcards.py` and add `quiz.py`. It keeps the same structure:
  `split_sections` → `retrieve_for_notes` → `progress.stream_structured` with
  `QUIZ_SCHEMA` → `_validate_quiz` → shuffle. Refusal, `max_tokens`, empty
  notes and no-sources errors are handled the same way.
- `prompts.py`: replace the flashcard prompt and builder with the quiz ones.
- `worker.py`: rename the flashcard queue functions to their quiz equivalents
  (`quizzes_available`, `reclaim_stale_quizzes`, `claim_next_quiz`,
  `_fail_quiz`, `process_quiz`), point the SQL at `quizzes`, write
  `questions`, change `_PROGRESS_TABLES` and the 012 column check to
  `quizzes`, and rename the startup queue and log lines.
- `progress.py`: update the docstring.

## API (`apps/api`)

- Delete `routers/flashcards.py` and add `routers/quizzes.py` with the same
  behavior under new paths:
  - `POST /documents/{id}/quiz` → 202 with a status row. 409 while a quiz is
    already pending or processing for that document.
  - `GET /documents/{id}/quiz` → status and progress. 404 when no quiz has
    been requested.
  - `GET /documents/{id}/quiz/content` → the finished quiz. 404 unless the
    newest row is `done`.
  - A `require_quizzes_table` guard returns 503 with instructions to apply
    014 when the table is missing.
- `models.py`: `FlashcardSet` becomes `Quiz` (`__tablename__ = "quizzes"`),
  with `notes` and `questions` deferred.
- `schemas.py`: `CreateQuiz`, `QuizStatusOut`, `QuizProgressOut`, `QuizOut`.
- `main.py`: register `quizzes.router` in place of `flashcards.router`.
- `generation_progress.py`: `_TABLES = ("study_guides", "quizzes")`.
- `routers/documents.py`: update the comment listing what a document delete
  cascades to.

## Web (`apps/web/src`)

- `lib/types.ts`: replace the flashcard types with `QuizStatus`,
  `QuizQuestion`, `Quiz`, `QuizStatusRow` and `QuizRow`.
- `lib/useQuiz.ts` replaces `useFlashcards.ts`. Same polling logic, including
  parking in a hidden tab, retrying a failed content fetch, and the
  worker-suspect hint. Only the paths, types and messages change.
- `components/QuizView.tsx` replaces `FlashcardsView.tsx`.
  - **Taking the quiz:** one question at a time with four selectable options.
    Prev/Next move between questions. Answers can be changed freely until
    Submit. A row of dots shows answered and unanswered questions, and
    clicking a dot jumps to that question. Submit is disabled until every
    question has an answer, and its label shows how many are left.
  - **Results:** the score as `n / total` and a percentage, then every
    question with the reader's answer and the correct answer marked, the
    explanation, and the citation (filename, page ref, excerpt). Retake
    clears the answers and goes back to question 1.
  - Keyboard: 1–4 select an option, ←/→ move between questions, Esc closes.
    Text goes through `formatChem`, as flashcards do now.
- `pages/SpacePage.tsx`: use `useQuiz` and `QuizView`. The toolbar labels
  become "Quiz" and "Writing quiz…".
- `styles.css`: replace the `.flashcard*` rules with `.quiz*` rules that use
  the existing tokens and work in both light and dark themes.

## Error handling

The existing paths stay as they are. A failed generation shows the
row's `error`. An empty document is refused in the browser before any request
is sent. A missing table returns a 503 that tells the operator what to run. A
validated quiz with zero questions is stored as a failure with the message
"No questions could be grounded in your sources", rather than being shown as
an empty quiz.

## Verification

1. `npm run build` in `apps/web` succeeds, which also runs `tsc`.
2. Running `_validate_quiz` and the shuffle on a hand-written sample model
   output drops each bad case listed above, and the correct option text still
   matches `correct_index` after shuffling.
3. End to end, with the API, realtime server, worker and web app running
   locally: generate a quiz on a real document, take it, submit, check the
   score and the review, and retake it. Repeat in dark mode.
4. A repo-wide search for "flashcard" outside migrations 007 and 012 finds
   nothing.
