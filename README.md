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
  web/            React + Tiptap + Yjs collaborative editor
  api/             FastAPI backend: study spaces, documents, suggestions
  agent-worker/     Ingestion pipeline + the AI agent process
packages/
  shared/           Shared TypeScript types
eval/
  test_cases/       Hand-written cases: source + notes + expected agent behavior
  run_eval.py       Scores the agent against test_cases
infra/
  init.sql          Postgres schema (six tables, pgvector extension)
```

## Local setup

1. **Database** — `docker compose up -d` starts Postgres with the `pgvector`
   extension and runs `infra/init.sql` on first boot.
2. **API** — `cd apps/api && pip install -r requirements.txt && uvicorn main:app --reload`
   Set `DATABASE_URL` in a `.env` file (see `database.py` for the expected format).
3. **Agent worker** — `cd apps/agent-worker && pip install -r requirements.txt`
   Set `ANTHROPIC_API_KEY` (or your provider of choice) and `DATABASE_URL`.
   Run `python ingest.py <path-to-pdf> <study_space_id>` to ingest a source,
   and `python agent.py <document_id>` to run one agent pass on demand.
4. **Web** — `cd apps/web && npm install && npm run dev`
   The collaborative editor needs a `y-websocket` server for real-time sync —
   run `npx y-websocket` locally, or swap in a managed provider (Liveblocks,
   PartyKit) and update the provider URL in `App.tsx`.
5. **Eval** — `cd eval && python run_eval.py` runs the agent against
   `test_cases/sample_course.json` and prints a score. Replace the sample
   with test cases built from a course you actually uploaded material for.

## What's stubbed vs. real

This scaffold wires up the real shape of the system — the data model, the
API surface, the suggestion flow, the eval harness — but the actual LLM
calls, embedding calls, and the y-websocket server are left as clearly
marked TODOs. Filling those in is most of the actual project; the scaffold
is here so you're deciding "what should the agent's prompt say" and "how
good is retrieval," not "how do I wire a CRDT editor to a database."

## Suggested build order

Follow the six-week plan in the build-plan doc: skeleton + deploy (week 1),
real-time editor (week 2), ingestion pipeline (week 3), agent v1 (week 4),
eval harness (week 5), polish (week 6). Deploying in week 1 is deliberate —
it surfaces infra problems while they're still cheap to fix.
