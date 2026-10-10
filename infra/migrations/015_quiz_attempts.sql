-- Weak spots: saved quiz attempts, and the two columns that make them mean
-- something.
--
-- quizzes.sections is the list of notes headings the browser sent with the
-- request. The worker tags each question with one of them (and drops any
-- question naming a heading that is not on the list), which is what lets an
-- attempt be counted per section. NULL on quizzes from before this file;
-- those are skipped by the weak-spot count rather than guessed at.
--
-- quizzes.personal_for marks a practice quiz: generated for one person from
-- their weak sections, visible only to them, and never the document's
-- "current quiz" (see routers/quizzes.py, which filters on IS NULL).
--
-- quiz_attempts holds every submit, retakes included. Weak spots are computed
-- on read from the latest attempt per quiz, so the threshold can change
-- without touching data. No document_id: it comes from the join to quizzes.
--
-- Idempotent, like 001-014. Locally:
--   docker compose exec -T db psql -U study_notes -d study_notes < infra/migrations/015_quiz_attempts.sql
-- then re-run infra/supabase/011_lockdown.sql on Supabase.

ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS sections TEXT[];
ALTER TABLE quizzes
    ADD COLUMN IF NOT EXISTS personal_for UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS quiz_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Chosen option per question, in question order.
    answers SMALLINT[] NOT NULL,
    -- Computed by the API from quizzes.questions, never taken from the client.
    score SMALLINT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs GET /documents/{id}/weak-spots, which reads one person's attempts.
CREATE INDEX IF NOT EXISTS quiz_attempts_user_idx
    ON quiz_attempts (user_id, submitted_at DESC);

ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;
