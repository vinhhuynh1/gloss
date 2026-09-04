-- Study Notes Co-Editor schema
-- Six tables: see the "Data model" section of the build-plan doc for the
-- rationale behind keeping `suggestions` separate from the doc's own text.
--
-- Portable: this runs unchanged against both the local docker-compose
-- pgvector image and a managed Postgres (Supabase). Nothing here references
-- Supabase-specific schemas — see infra/supabase/ for that.
--
-- Idempotent, so re-applying to an existing database is safe.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS study_spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_name TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS study_space_members (
    study_space_id UUID NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'member'
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (study_space_id, user_id)
);

-- One shared notes doc per study space. The CRDT binary state is the
-- source of truth for the text; nothing else in this schema parses it.
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_space_id UUID NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
    crdt_snapshot BYTEA, -- latest Yjs document state, updated periodically
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_space_id UUID NOT NULL REFERENCES study_spaces(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    uploaded_by UUID NOT NULL REFERENCES users(id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The searchable units the agent retrieves against. `embedding` dimension
-- must match whatever embedding model ingest.py is configured to use.
CREATE TABLE IF NOT EXISTS source_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    embedding VECTOR(384),
    page_ref TEXT -- e.g. "slide 14" or "p. 32", shown in citations
);

-- Every AI proposal. Kept fully separate from the document's own text so
-- the agent can never write directly into the shared doc.
CREATE TABLE IF NOT EXISTS suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- 'citation' | 'contradiction' | 'gap_fill'
    anchor JSONB NOT NULL, -- serialized Yjs relative position
    proposed_text TEXT NOT NULL,
    source_chunk_id UUID REFERENCES source_chunks(id),
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ
);
