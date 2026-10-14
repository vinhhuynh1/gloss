-- Which sources a study guide or quiz is built from
-- (docs/superpowers/specs/2026-10-13-demo-upload-and-source-picker-design.md).
--
-- NULL means every source in the space, which is what every row written
-- before this migration meant, so no backfill. The worker narrows retrieval
-- and its wait-for-uploads condition to these ids when set. Not a foreign
-- key: Postgres arrays cannot carry one, and a source deleted after the
-- request is simply absent from retrieval.
ALTER TABLE study_guides ADD COLUMN IF NOT EXISTS source_ids UUID[];
ALTER TABLE quizzes      ADD COLUMN IF NOT EXISTS source_ids UUID[];
