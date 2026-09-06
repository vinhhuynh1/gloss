# Study Notes Co-Editor

A real-time collaborative notes doc with an AI agent that grounds itself in your
actual course material — it cites sources, flags contradictions, and fills gaps
as accept/reject suggestions. It never edits the shared document directly.

See the full design writeup ("Study Notes Co-Editor — Build Plan") for the
product walkthrough, architecture rationale, and the evaluation methodology.
This repo is the starter scaffold for building it.

## Layout

```
apps/
  web/              React + Tiptap + Yjs collaborative editor
  api/              FastAPI backend: study spaces, documents, suggestions
  realtime/         Yjs WebSocket sync server (auth on upgrade, Postgres persistence)
  agent-worker/     Ingestion pipeline + the AI agent process
packages/
  shared/           Shared TypeScript types
eval/
  test_cases/       Hand-written cases: source + notes + expected agent behavior
  run_eval.py       Scores the agent against test_cases
infra/
  migrations/       Portable Postgres schema (six tables, pgvector extension)
  supabase/         Supabase-only: auth mirroring and RLS lockdown
```

## Local setup

Start them in this order — each depends on the one before it.

1. **Database** — `docker compose up -d` starts Postgres with the `pgvector`
   extension and applies `infra/migrations/` on first boot. Against Supabase
   instead, see `infra/README.md`.
2. **API** — `cd apps/api && pip install -r requirements.txt && uvicorn main:app --reload`
   Copy `.env.example` to `.env` (see `database.py` for the expected format).
3. **Realtime** — `cd apps/realtime && npm install && npm run dev`
   Copy `.env.example` to `.env` first; `npm run dev` loads it, `npm start`
   does not. This is the Yjs sync server the editor connects to — it
   authenticates every connection against a Supabase JWT plus study-space
   membership, and it is the writer of record for `documents.crdt_snapshot`.
   **It must run at exactly one replica** (see the comment at the top of
   `server.js`). `docker compose up` can run it for you instead.
4. **Web** — `cd apps/web && npm install && npm run dev`
   Copy `.env.example` to `.env.local` and fill in all four `VITE_*` values —
   they are baked in at build time and the app fails loudly at load if any is
   missing. `VITE_WS_URL` points at the realtime server from step 3.
5. **Agent worker** — `cd apps/agent-worker && pip install -r requirements.txt`
   Set `ANTHROPIC_API_KEY` (or your provider of choice) and `DATABASE_URL`.
   Run `python ingest.py <path-to-pdf> <study_space_id>` to ingest a source,
   and `python agent.py <document_id>` to run one agent pass on demand.
6. **Eval** — `cd eval && python run_eval.py` runs the agent against
   `test_cases/sample_course.json` and prints a score. Replace the sample
   with test cases built from a course you actually uploaded material for.

> Testing collaboration in two tabs of the **same** browser profile proves
> nothing: y-websocket syncs same-origin tabs directly over BroadcastChannel,
> so they stay in sync even with the realtime server stopped. Use two browsers,
> or one normal and one private window — ideally signed in as two users.

## What's stubbed vs. real

Real: the data model, the API surface with auth and membership checks, the
ingestion and embedding pipeline, the collaborative editing path end to end
(`apps/realtime` authenticates on upgrade and persists to Postgres), and the
eval harness's shape.

Still stubbed, and clearly marked in code: the agent's LLM call
(`apps/agent-worker/agent.py`), the suggestion decorations in the document and
applying an accepted suggestion into the Yjs doc (`Editor.tsx`,
`SuggestionSidebar.tsx`), and the eval test cases themselves — the sample is a
placeholder for cases built from a course you actually uploaded material for.

Filling those in is most of the actual project; the scaffold is here so you're
deciding "what should the agent's prompt say" and "how good is retrieval," not
"how do I wire a CRDT editor to a database."

## Suggested build order

Follow the six-week plan in the build-plan doc: skeleton + deploy (week 1),
real-time editor (week 2), ingestion pipeline (week 3), agent v1 (week 4),
eval harness (week 5), polish (week 6). Deploying in week 1 is deliberate —
it surfaces infra problems while they're still cheap to fix.