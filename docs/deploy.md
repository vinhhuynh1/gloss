# Deploy

Four pieces across three hosts, plus the one-time setup demo mode needs.


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

## 1. Supabase

Create the project, then apply the seven SQL files in the order given in
[`infra/README.md`](../infra/README.md), which also covers the one thing that
reliably goes wrong: **use the session pooler host on port 5432**, not
`db.<ref>.supabase.co`, which is IPv6-only on the free tier and unreachable
from Railway.

Then, under Authentication → Sign In / Providers → Email, turn **"Confirm
email" off**. The login screen is email + password by design, and with
confirmation on, `signUp()` returns no session and no error — the UI just
resets the button, which reads as a dead app. The free tier's shared SMTP is
rate-limited to a couple of messages an hour, so this is not a setting to
leave on and hope.

One more thing worth reading before you put load on it: the free tier's tight
constraint is **egress, not storage**, and this app reads on poll loops rather
than on clicks. `infra/README.md` has the arithmetic and the rule it produced —
the short version is that an unbounded column is deferred on the mapper in
`apps/api/models.py`, because leaving it out of the response model keeps it off
the wire but not out of the query.

Check how the project signs its JWTs while you are there:

```sh
curl https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
```

Keys returned means asymmetric — leave `SUPABASE_JWT_SECRET` unset everywhere
and both services verify via JWKS. An empty `keys` array means the project is
on the legacy shared HS256 secret, and `SUPABASE_JWT_SECRET` must be set on
**both** the API and realtime. Getting this wrong 401s every request with an
identical, unhelpful message.

## 2. Railway — two services from this one repo

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

## 3. Vercel — the web app

Root Directory `apps/web`; the Vite preset supplies the rest. Set the
**Production Branch** to whatever branch you are shipping — left on `main`
while you deploy a feature branch, every push produces a preview deploy on a
new per-commit hostname, and the API's `ALLOWED_ORIGINS` stops matching on
each one.

All five `VITE_*` values must be set before the first build. They are compiled
into the bundle, and `src/lib/env.ts` throws at module load if a required one
is missing, so a build without them ships a page that white-screens.

## Environment variables

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

**A migration lands before the code that needs it, not after.** Railway
redeploys on every merge to `main`, and `infra/migrations/` is applied by hand,
so merging a PR that adds a table is a deploy of code against a schema that
does not have it yet. Apply the new file to Supabase first, re-run
`011_lockdown.sql`, and merge second. This is not hypothetical — `005` was
merged before it was applied, and the worker crash-looped on
`UndefinedTable: relation "study_guides" does not exist` until it was. The
worker now turns that specific case into a warning and keeps ingesting (see
`study_guides_available` in `worker.py`), but the ordering is still the thing
that makes a deploy uneventful.

## Verify the deployment

```sh
curl https://<api-host>/health                      # {"status":"ok"}
curl https://<realtime-host>/health                 # {"status":"ok","documents":0}
curl -i -X POST https://<api-host>/dev/login        # must be 404
```

That last one is the one to actually run: a 404 proves the passwordless login
is not mounted.

Then sign up two users in **two different browsers** (see the note at the end of
[setup.md](setup.md) about why two tabs prove nothing), open the same document link in both, and confirm
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

## Known limits

The Supabase free tier **pauses a project after 7 days of inactivity** and
needs a manual restore, so a portfolio link demoed a month later hits a dead
database. It also caps storage at 500 MB, and uploaded sources are stored as
`bytea` in Postgres at up to 20 MB each — roughly 25 max-size files fills it.
Object storage is the documented upgrade, not a week-1 requirement.

## Demo mode

`/#/demo` (or "Try the demo" on the sign-in screen) gives a visitor a private
copy of a template study space, without an account.

Setup, once per Supabase project — **in this order**:

1. Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins**.
2. Apply `infra/migrations/016_guest_users.sql` and
   `infra/migrations/017_generation_sources.sql`, **then**
   `infra/supabase/013_guest_signups.sql`. Do both **before** merging or
   deploying this code: the API's models read `users.is_guest` and
   `study_spaces.is_demo` on every request, so an API deployed ahead of 016
   fails every signed-in request, not just guests'. And 013 applied before
   016 breaks every signup.
3. On the API service set `DEMO_TEMPLATE_SPACE_ID` to the space to copy, and
   optionally `DEMO_DAILY_LIMIT` (default 50 new demos per day).
4. Merge and redeploy the API, worker and web app.

Guests get 5 checks, 3 chat questions, 1 study guide and 1 quiz, can't upload
or invite, and are deleted by the worker after 24 hours. Limits live in
`GUEST_LIMITS` in `apps/api/authz.py`. Editing the template space changes what
new visitors get.
