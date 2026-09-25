-- Comment threads anchored to a passage in the notes.
--
-- The first thing in this schema that is not a queue. 003, 004 and 005 all
-- exist because the worker has to pick work up from somewhere; a comment is
-- written by a person and read by people, so the API owns it end to end and
-- apps/agent-worker never touches this table.
--
-- Idempotent, like 001-005. Against an existing local database apply it by
-- hand:  psql "$DATABASE_URL" -f infra/migrations/006_comments.sql
--
-- Remember to re-run infra/supabase/011_lockdown.sql after this: a new table
-- is readable through PostgREST with the public anon key until it is.

-- One table for roots and replies rather than two.
--
-- A reply is a comment that happens to have a parent, and the alternative —
-- a comment_threads table plus a comments table — buys a place to hang
-- resolved_at and buys nothing else, at the cost of two inserts to start a
-- thread and a join to read one. The constraints below are what keep the
-- one-table version honest.
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- NULL for the comment that starts a thread, set for every reply.
    -- CASCADE: deleting a root takes its replies, which is what "delete this
    -- thread" has to mean.
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    body TEXT NOT NULL,

    -- Serialized Yjs relative positions {from, to, quote}, computed by the
    -- browser — the same shape as suggestions.anchor and agent_requests.anchor,
    -- produced by the same selectionToAnchor() in apps/web/src/lib/anchors.ts.
    -- Opaque to Postgres and to Python; only the editor can resolve one.
    --
    -- Only a root carries an anchor. A reply belongs to its parent's passage,
    -- and giving replies their own would let a thread drift across the
    -- document one reply at a time.
    anchor JSONB,
    -- The passage as it read when the thread was opened. The anchor is the
    -- live position and it can be lost — a collaborator deleting the passage
    -- collapses it to an empty range — and a comment whose subject has
    -- vanished still has to be able to say what it was about. Same reasoning
    -- as the source_excerpt snapshot 004 added to suggestions.
    quote TEXT,

    -- Resolving is a property of the thread, so it lives on the root only.
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ,

    -- A root has an anchor; a reply has a parent and neither an anchor nor a
    -- resolution. Without this the two shapes drift apart the first time a
    -- client sends the wrong one, and a reply carrying its own anchor would
    -- render as a second highlight over the same text.
    CONSTRAINT comments_root_or_reply CHECK (
        (parent_id IS NULL AND anchor IS NOT NULL)
        OR (parent_id IS NOT NULL AND anchor IS NULL AND resolved_at IS NULL)
    )
);

-- Backs GET /documents/{id}/comments, which the editor polls while a document
-- is open. Ordered by created_at because a thread reads oldest-first.
CREATE INDEX IF NOT EXISTS comments_document_created_idx
    ON comments (document_id, created_at);

-- Replies are fetched per root when a thread is expanded.
CREATE INDEX IF NOT EXISTS comments_parent_idx
    ON comments (parent_id)
    WHERE parent_id IS NOT NULL;

-- The open threads are what the editor highlights, and in a document that has
-- been used for a term they are the small minority. Partial for the same
-- reason as sources_pending_idx.
CREATE INDEX IF NOT EXISTS comments_open_idx
    ON comments (document_id, created_at)
    WHERE parent_id IS NULL AND resolved_at IS NULL;

-- Who was @mentioned, as rows rather than as a scan of every body.
--
-- Parsed from the body once, on write. The alternative — finding mentions by
-- searching the text when they are needed — means every "am I mentioned
-- anywhere" question is a full scan of every comment in the space, and it
-- makes a display name containing an @ into a mention.
--
-- No notifications are sent from here; this is what the UI reads to highlight
-- a mention and what a future notification job would read. Deliberately out of
-- scope for now.
CREATE TABLE IF NOT EXISTS comment_mentions (
    comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS comment_mentions_user_idx
    ON comment_mentions (user_id);
