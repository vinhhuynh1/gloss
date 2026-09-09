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
  agent-worker/     Ingestion worker + retrieval + the AI agent process
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
   missing. `VITE_WS_URL` points at the realtime server from step 3. To skip
   Supabase entirely, set `VITE_DEV_AUTH=1` and leave the two `VITE_SUPABASE_*`
   values empty; that pairs with `DEV_AUTH_SECRET` in steps 2 and 3.
5. **Agent worker** — `cd apps/agent-worker && pip install -r requirements.txt`
   Set `ANTHROPIC_API_KEY` (or your provider of choice) and `DATABASE_URL`.
   Then run `python worker.py` and leave it running: it is what turns files
   uploaded in the web app into searchable chunks. Without it an upload
   succeeds and then sits at "Queued" forever — the panel says so after a
   few seconds, because it is the easiest thing to forget.

   The other entry points are one-shot:
   - `python ingest.py <path-to-pdf> <study_space_id> <user_id>` — ingest a
     file straight off disk, no upload and no worker needed.
   - `python search.py <study_space_id> "a question"` — query the vector
     store by hand. This is how you check that ingestion actually worked;
     it stops before the LLM, so it costs nothing and it separates a
     retrieval problem from a prompt problem.
   - `python agent.py <document_id> <study_space_id> "<passage>"` — one
     agent pass on demand.
   - `python worker.py --requeue [study_space_id]` — re-chunk and re-embed
     material already ingested, after changing `CHUNK_SIZE_CHARS` or the
     embedding model. Re-running replaces a source's chunks rather than
     duplicating them, so this is safe to repeat.
6. **Eval** — `cd eval && python run_eval.py` runs the agent against
   `test_cases/sample_course.json` and prints a score. Replace the sample
   with test cases built from a course you actually uploaded material for.

> Testing collaboration in two tabs of the **same** browser profile proves
> nothing: y-websocket syncs same-origin tabs directly over BroadcastChannel,
> so they stay in sync even with the realtime server stopped. Use two browsers,
> or one normal and one private window — ideally signed in as two users.

## Deploy

Four pieces, three hosts, and one of them stays on your laptop.

| | Where | Root directory | Config in repo |
|---|---|---|---|
| Database | Supabase (a second project, used as `prod`) | — | `infra/` |
| API | Railway service | `apps/api` | `Dockerfile`, `railway.json` |
| Realtime | Railway service | `apps/realtime` | `Dockerfile`, `railway.json` |
| Web | Vercel | `apps/web` | none needed |
| Agent worker | **not deployed** — runs locally against the hosted database | — | — |

The worker stays local because `sentence-transformers` pulls in torch; point
its `DATABASE_URL` and `API_BASE_URL` at the hosted values and run it from your
machine. `apps/agent-worker/.env.example` says the same thing.

The web app needs no rewrite rules on any static host — it routes on the hash
(`src/lib/useHashRoute.ts`), so `/` is the only path ever requested.

### 1. Supabase

Create the project, then apply the five SQL files in the order given in
[`infra/README.md`](infra/README.md), which also covers the one thing that
reliably goes wrong: **use the session pooler host on port 5432**, not
`db.<ref>.supabase.co`, which is IPv6-only on the free tier and unreachable
from Railway.

Then, under Authentication → Sign In / Providers → Email, turn **"Confirm
email" off**. The login screen is email + password by design, and with
confirmation on, `signUp()` returns no session and no error — the UI just
resets the button, which reads as a dead app. The free tier's shared SMTP is
rate-limited to a couple of messages an hour, so this is not a setting to
leave on and hope.

Check how the project signs its JWTs while you are there:

```sh
curl https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
```

Keys returned means asymmetric — leave `SUPABASE_JWT_SECRET` unset everywhere
and both services verify via JWKS. An empty `keys` array means the project is
on the legacy shared HS256 secret, and `SUPABASE_JWT_SECRET` must be set on
**both** the API and realtime. Getting this wrong 401s every request with an
identical, unhelpful message.

### 2. Railway — two services from this one repo

What tells Railway which service is which is the **Root Directory** setting;
everything else comes from the `railway.json` beside each Dockerfile. Both
services also need their branch set — Railway defaults to `main`.

Generate both public domains as soon as the services exist. You need those
hostnames to build the web app, and knowing them up front removes most of the
ordering problem below. Answer `8080` when asked for the target port, and set
`PORT=8080` on both services to match.

`apps/realtime/railway.json` pins `numReplicas: 1`. That is not a default worth
losing — two replicas silently fork every open document and the last writer
wins at flush time. The reasoning is at the top of `apps/realtime/server.js`.

### 3. Vercel — the web app

Root Directory `apps/web`; the Vite preset supplies the rest. Set the
**Production Branch** to whatever branch you are shipping — left on `main`
while you deploy a feature branch, every push produces a preview deploy on a
new per-commit hostname, and the API's `ALLOWED_ORIGINS` stops matching on
each one.

All five `VITE_*` values must be set before the first build. They are compiled
into the bundle, and `src/lib/env.ts` throws at module load if a required one
is missing, so a build without them ships a page that white-screens.

### Environment variables

| Variable | API | Realtime | Web |
|---|---|---|---|
| `DATABASE_URL` | pooler URI, **`postgresql+psycopg://`** | same URI, plain **`postgresql://`** | — |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | same | — |
| `SUPABASE_JWT_SECRET` | only on legacy HS256 projects | same | — |
| `DEV_AUTH_SECRET` | **never set** | **never set** | — |
| `ALLOWED_ORIGINS` | the Vercel origin, no trailing slash | — | — |
| `AGENT_SERVICE_TOKEN` | generated secret | — | — |
| `PORT` | `8080` | `8080` | — |
| `PGSSL_DISABLE` | — | **never set** — it is truthiness-checked, so even `0` turns TLS off | — |
| `PG_POOL_MAX` | — | `3` on the free tier | — |
| `VITE_API_BASE_URL` | — | — | `https://<api-host>` |
| `VITE_WS_URL` | — | — | `wss://<realtime-host>` |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | — | — | from Project Settings → API |
| `VITE_DEV_AUTH` | — | — | `0`, explicitly |

Three things in that table are the ones that actually bite:

- **One connection string, two dialects.** The API is SQLAlchemy and needs
  `+psycopg`; realtime is node-postgres and must not have it. The worker is
  the plain form too.
- **`DEV_AUTH_SECRET` absent is the entire production safety.** Set on the API
  it mounts `POST /dev/login`, which issues a valid 12-hour token for any email
  address with no password. There is no flag to get wrong — only a variable to
  not set.
- **`wss://`, not `ws://`.** A browser blocks plain WebSockets from an https
  page as mixed content, and the value is baked in at build time, so fixing it
  means a redeploy rather than a config change.

**Order:** Supabase → both Railway services with domains generated and every
variable except `ALLOWED_ORIGINS` → Vercel project, using the Railway
hostnames → set `ALLOWED_ORIGINS` to the Vercel origin and let Railway
redeploy → set the Supabase Site URL. Naming the Vercel project first makes
`https://<name>.vercel.app` predictable, so `ALLOWED_ORIGINS` can be filled in
one pass and merely confirmed at the end.

### Verify the deployment

```sh
curl https://<api-host>/health                      # {"status":"ok"}
curl https://<realtime-host>/health                 # {"status":"ok","documents":0}
curl -i -X POST https://<api-host>/dev/login        # must be 404
```

That last one is the one to actually run: a 404 proves the passwordless login
is not mounted.

Then sign up two users in **two different browsers** (see the note above about
why two tabs prove nothing), open the same document link in both, and confirm
the text and cursors propagate. To prove it is really persisting rather than
living in browser memory, use the query in `infra/README.md` — `bytes` should
grow a few seconds after you stop typing, and the text should survive a hard
reload of both browsers.

The realtime server's auth gates have a script already:

```sh
cd apps/realtime
node ws-smoke-test.js wss://<realtime-host> <document-uuid> <member-token> <outsider-token>
```

Both tokens come out of `localStorage` under `sb-<ref>-auth-token` after
signing in; they expire in an hour. Expect 401, 401, 400, 403, connected. A
`timeout` instead of a status code means the upgrade never reached the app —
that is Railway routing or the wrong target port, not your auth.

### Known limits

The Supabase free tier **pauses a project after 7 days of inactivity** and
needs a manual restore, so a portfolio link demoed a month later hits a dead
database. It also caps storage at 500 MB, and uploaded sources are stored as
`bytea` in Postgres at up to 20 MB each — roughly 25 max-size files fills it.
Object storage is the documented upgrade, not a week-1 requirement.

## What's stubbed vs. real

Real: the data model, the API surface with auth and membership checks, the
collaborative editing path end to end (`apps/realtime` authenticates on
upgrade and persists to Postgres), the ingestion pipeline end to end (upload
in the browser → queued on the `sources` row → chunked and embedded by
`apps/agent-worker/worker.py` → searchable with `search.py`, scoped per study
space), and the eval harness's shape.

Still stubbed, and clearly marked in code: the suggestion's document anchor
(`yjs_relative_position_for` in `apps/agent-worker/agent.py` — the real one is
computed client-side by the frontend trigger that does not exist yet), the
suggestion decorations in the document and applying an accepted suggestion into
the Yjs doc (`Editor.tsx`, `SuggestionSidebar.tsx`), and the eval test cases
themselves — the sample is a placeholder for cases built from a course you
actually uploaded material for.

Filling those in is most of the actual project; the scaffold is here so you're
deciding "what should the agent's prompt say" and "how good is retrieval," not
"how do I wire a CRDT editor to a database."

## Suggested build order

Follow the six-week plan in the build-plan doc: skeleton + deploy (week 1),
real-time editor (week 2), ingestion pipeline (week 3), agent v1 (week 4),
eval harness (week 5), polish (week 6). Deploying in week 1 is deliberate —
it surfaces infra problems while they're still cheap to fix.