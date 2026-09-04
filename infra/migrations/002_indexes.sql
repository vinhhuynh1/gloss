-- Indexes, kept separate from 001_init.sql so the vector index choice is
-- easy to find and revisit as the corpus grows.

-- HNSW, deliberately not ivfflat.
--
-- ivfflat derives its cluster centroids at BUILD time. Built against an empty
-- source_chunks (which is exactly when schema setup runs), the centroid list
-- is degenerate, and the `<=>` probe in apps/agent-worker/agent.py:55 then
-- searches lists that hold nothing. Retrieval keeps returning rows, they are
-- just the wrong ones — nothing ever fails loudly. That is the same class of
-- silent-wrongness the docstring in apps/agent-worker/embeddings.py warns
-- about, and it would look like "the agent's suggestions are mediocre"
-- rather than like a bug.
--
-- HNSW builds incrementally and is correct on an empty table, so the index
-- can live in the schema instead of being a post-ingest ritual that has to be
-- remembered. Slower to build and slightly more memory; both irrelevant at
-- this corpus size.
--
-- The operator class must stay vector_cosine_ops to match the `<=>` operator
-- used in agent.py. Do not "optimize" it to vector_ip_ops on the grounds that
-- embeddings.py normalizes — a mismatch here reintroduces the silent bug.
CREATE INDEX IF NOT EXISTS source_chunks_embedding_idx
    ON source_chunks USING hnsw (embedding vector_cosine_ops);

-- Foreign keys the app actually filters and joins on. None were indexed.
-- The retrieval query walks source_chunks -> sources -> study_space.
CREATE INDEX IF NOT EXISTS source_chunks_source_id_idx
    ON source_chunks (source_id);
CREATE INDEX IF NOT EXISTS sources_study_space_id_idx
    ON sources (study_space_id);
CREATE INDEX IF NOT EXISTS documents_study_space_id_idx
    ON documents (study_space_id);

-- Matches the filter in apps/api/routers/suggestions.py.
CREATE INDEX IF NOT EXISTS suggestions_document_status_idx
    ON suggestions (document_id, status);

-- Backs "list the spaces this user belongs to".
CREATE INDEX IF NOT EXISTS study_space_members_user_id_idx
    ON study_space_members (user_id);
