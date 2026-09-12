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
  judge.py          Optional: asks the model whether a citation really supports
  results/          One JSON record per run, with the config that produced it
  CHANGELOG.md      What each change did to the score
infra/
  migrations/       Portable Postgres schema (eight tables, pgvector extension)
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
   Set `ANTHROPIC_API_KEY` and `DATABASE_URL`. Then run `python worker.py`
   and leave it running. It does two jobs:
   - turns files uploaded in the web app into searchable chunks, and
   - answers **Check with AI** — select a passage in the notes and click the
     button (or Ctrl/Cmd+Alt+M), and the worker retrieves from that space's
     sources, asks the model, and writes back a suggestion that appears
     highlighted in the doc and as a card in the sidebar.

   Without it, uploads sit at "Queued" and checks at "Checking…" forever —
   both panels say so after a few seconds, because it is the easiest thing
   to forget. Checks are claimed ahead of uploads, but one worker does one
   thing at a time, so a check asked for while a long PDF is mid-ingest waits
   for it to finish.

   The other entry points are one-shot:
   - `python ingest.py <path-to-pdf> <study_space_id> <user_id>` — ingest a
     file straight off disk, no upload and no worker needed.
   - `python search.py <study_space_id> "a question"` — query the vector
     store by hand. This is how you check that ingestion actually worked;
     it stops before the LLM, so it costs nothing and it separates a
     retrieval problem from a prompt problem.
   - `python agent.py <document_id> <study_space_id> "<passage>"` — one
     agent pass from the command line, posted through the API (needs
     `API_BASE_URL` and `AGENT_SERVICE_TOKEN`). The suggestion has no
     position in the doc, so it shows unhighlighted and can only be
     dismissed; use it to debug the agent, not to drive the app.
   - `python worker.py --requeue [study_space_id]` — re-chunk and re-embed
     material already ingested, after changing `CHUNK_SIZE_CHARS` or the
     embedding model. Re-running replaces a source's chunks rather than
     duplicating them, so this is safe to repeat.
6. **Eval** — scores the agent against `test_cases/sample_course.json`, 18
   hand-written cases over the sample course. It needs a study space that
   already has material ingested, because retrieval is scoped to one:

   ```sh
   cd apps/agent-worker && python seed_demo.py    # prints a study_space_id
   STUDY_SPACE_ID=<uuid> python ../eval/run_eval.py
   ```

   In PowerShell the first line is `$env:STUDY_SPACE_ID="<uuid>"; python ...`
   — `VAR=value cmd` is not a thing there, and the script exits with that
   reminder rather than scoring every case against an empty retrieval.

   It reports five numbers, not one. Type accuracy and a confusion matrix
   answer "did it reach the right verdict"; flag precision and recall split
   that into "did it flag what it should" and "did it stay quiet where it
   should"; grounding accuracy asks whether the verdict cited the section
   that actually backs it. The fifth, retrieval recall@k, is the one that
   tells you where to look: if the right section is not even being retrieved,
   no amount of prompt work will help, and `search.py` is where you go next.

   Every run drops a record in `eval/results/` carrying the model, prompt
   hash, `top_k`, chunk size, and a fingerprint of the corpus, so a score can
   always be traced back to the code that produced it. `--compare latest`
   diffs against the previous run and names the cases that moved. Add a line
   to `eval/CHANGELOG.md` each time — the build plan asks for that log
   specifically, and one change at a time is the only way it means anything.

   `--judge` adds a second model call per suggestion asking whether the cited
   excerpt really supports it. Useful for auditing a run before you write it
   up; not something to hillclimb against, since the judge drifts too.

> Testing collaboration in two tabs of the **same** browser profile proves
> nothing: y-websocket syncs same-origin tabs directly over BroadcastChannel,
> so they stay in sync even with the realtime server stopped. Use two browsers,
> or one normal and one private window — ideally signed in as two users.

## Deploy

Four pieces across three hosts.

| | Where | Root directory | Config in repo |
|---|---|---|---|
| Database | Supabase (a second project, used as `prod`) | — | `infra/` |
| API | Railway service | `apps/api` | `Dockerfile`, `railway.json` |
| Realtime | Railway service | `apps/realtime` | `Dockerfile`, `railway.json` |
| Web | Vercel | `apps/web` | none needed |
| Agent worker | Railway service | `apps/agent-worker` | `Dockerfile`, `railway.json` |

The worker is the one piece that can also just run on your laptop against the
hosted database — it only talks *outbound*, to Postgres and the Claude API, so
it needs no inbound access. Deploy it when someone else has to be able to use
the app without you running anything.

Two things about its image. `sentence-transformers` depends on torch, and the
default PyPI wheel bundles a CUDA runtime that is useless on a CPU host and
roughly doubles the image, so the Dockerfile installs the CPU build from
PyTorch's own index **before** `requirements.txt`. The model weights are baked
in at build time rather than fetched on first use, because the download is an
unauthenticated Hugging Face request that is rate-limited. It still comes to
~2.2 GB; that is the price of embedding locally, and the way out is a hosted
embedding API, which would change the vectors and so needs a re-ingest and a
new `VECTOR(...)` dimension in three places (see `embeddings.py`).

It is a worker, not a server: no port, no domain, and `railway.json`
deliberately has no `healthcheckPath` — Railway would wait forever for a port
that never opens. Replicas are safe if you ever want more than one, because
`claim_next()` claims rows with `FOR UPDATE SKIP LOCKED` and `reclaim_stale()`
returns rows abandoned by a worker that died mid-deploy.

It needs exactly two variables — `DATABASE_URL` (the plain `postgresql://`
form, same as realtime) and `ANTHROPIC_API_KEY`. Not `API_BASE_URL` and not
`AGENT_SERVICE_TOKEN`: those belong to `agent.py`'s command-line path, which
posts through the API. The worker writes suggestions straight to Postgres.

The web app needs no rewrite rules on any static host — it routes on the hash
(`src/lib/useHashRoute.ts`), so `/` is the only path ever requested.

### 1. Supabase

Create the project, then apply the six SQL files in the order given in
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
space), and the agent end to end:

- **Ask** — select a passage, Check with AI. The editor turns the selection
  into two Yjs relative positions (`apps/web/src/lib/anchors.ts`), which keep
  pointing at the same characters however the doc is edited around them, and
  queues a row in `agent_requests`.
- **Answer** — the worker claims it, retrieves from that space only, and gets a
  schema-constrained verdict from the model (`agent.py`). A verdict that cites
  nothing it was shown is downgraded to "no suggestion" rather than shown. The
  suggestion is written with the anchor and a snapshot of the cited source.
- **Show** — pending suggestions are highlighted in the doc
  (`extensions/SuggestionHighlights.ts`, view-only decorations, never document
  content) and listed with their source in the sidebar.
- **Decide** — Accept records the decision first (the API refuses a second
  one, so two people accepting at once cannot insert twice), then inserts the
  text as an ordinary edit that syncs like typing (`lib/applySuggestion.ts`).
  Nothing the group wrote is ever replaced: a contradiction is added as a note
  after the passage it flags.

Also real: the eval harness. Eighteen hand-written cases score the agent on
whether it flagged what it should, stayed quiet where it should, and cited a
section that actually backs the claim, and every run leaves a record of the
config behind it.

Still a placeholder: the **course material**. The eighteen cases are written
against `test_cases/sample_course_source.md`, a synthetic cellular-respiration
handout, not against a course you uploaded — so the score says the agent works
on material shaped like a course, which is weaker than what the build plan
asks for. Swapping in real slides means a new source file, a re-seed, and
rewriting the cases against it; the harness needs no changes. Also still
open: the stretch goals (a background agent on a debounce, study-guide
export).

**Scored, and improved once against the score.** The baseline and four measured
changes are in `eval/CHANGELOG.md`, one entry each, with the run record behind
every number:

| | baseline | now |
|---|---|---|
| type accuracy | 67% | 72% |
| flag precision | 71% | 80% |
| flag recall | 100% | 100% |
| grounding accuracy | 83% | 92% |
| retrieval recall@k | 92% | 92% |

The log is more useful than the table. One queued change was dropped without
being run, because the baseline showed it aimed at a failure mode that never
occurred. One change made the score *worse* and was kept, because what it
exposed was a prompt bug rather than a bad fix — and the next change returned
the points. Retrieval recall@k never moved across five runs: every point came
from the prompt, which is worth knowing before spending anything on the
retriever.

The agent's quality is now the actual project: what the prompt says, and how
good retrieval is. `eval/run_eval.py` measures both and keeps them apart —
grounding accuracy for the prompt, retrieval recall@k for the retriever — so
a bad score points somewhere. `search.py` is how you dig into the second
without spending a token.

## Suggested build order

Follow the six-week plan in the build-plan doc: skeleton + deploy (week 1),
real-time editor (week 2), ingestion pipeline (week 3), agent v1 (week 4),
eval harness (week 5), polish (week 6). Deploying in week 1 is deliberate —
it surfaces infra problems while they're still cheap to fix.