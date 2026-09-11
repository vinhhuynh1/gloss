# Schema

Two sets of SQL, split by portability.

| Directory | Runs on | Applied by |
|---|---|---|
| `migrations/` | Local docker-compose Postgres **and** Supabase | compose first-boot, or `psql` |
| `supabase/` | Supabase only | `psql` by hand, once per project |

`supabase/` is deliberately outside the directory `docker-compose.yml` mounts.
`010_auth_sync.sql` references `auth.users`, which does not exist on the
`ankane/pgvector` image, so including it would abort local first boot.

## Local

`docker compose up -d` mounts `migrations/` at
`/docker-entrypoint-initdb.d`. The Postgres entrypoint runs every `*.sql`
there in alphabetical order, so `001` through `004`, on the **first boot of an
empty volume only**. To re-apply after editing:

```sh
docker compose down -v && docker compose up -d
```

That drops your data. A database created before a migration was added is the
common case, and applying just the new file keeps it:

```sh
docker exec -i <db-container> psql -U study_notes -d study_notes < infra/migrations/004_agent_requests.sql
```

Every file here is idempotent, so applying one twice is harmless.

## Supabase

Get the connection string from **Project Settings → Database → Connection
string → URI**, and use the **Session pooler** entry, not the direct one:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

> **Use the pooler host.** `db.<ref>.supabase.co` is IPv6-only on the free
> tier. Railway's egress is IPv4, so the direct host fails there with an
> opaque `Network is unreachable`. The session pooler on port 5432 is
> IPv4-reachable and supports prepared statements.
>
> If you ever switch to the *transaction* pooler on port 6543, psycopg3 will
> error on the second request unless prepared statements are disabled —
> see the note in `apps/api/database.py`.

Then, from the repo root:

```sh
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'

psql "$SUPABASE_DB_URL" -f infra/migrations/001_init.sql
psql "$SUPABASE_DB_URL" -f infra/migrations/002_indexes.sql
psql "$SUPABASE_DB_URL" -f infra/migrations/003_source_ingestion.sql
psql "$SUPABASE_DB_URL" -f infra/migrations/004_agent_requests.sql
psql "$SUPABASE_DB_URL" -f infra/supabase/010_auth_sync.sql
psql "$SUPABASE_DB_URL" -f infra/supabase/011_lockdown.sql
```

No `psql` on the machine? Docker has one, and feeding the file over stdin
rather than mounting it avoids path translation on Windows entirely:

```sh
docker run --rm -i postgres:16 psql "$SUPABASE_DB_URL" < infra/migrations/001_init.sql
```

Pasting into the Supabase SQL editor works too, but running the files keeps
applying the schema a repeatable act rather than a one-off click.

All six are idempotent — re-running them is safe. `011_lockdown.sql` has to
be re-run whenever a migration adds a table, or the new table is readable
through PostgREST with the public anon key.

### Verify

```sql
\dt                                                  -- eight tables
\d source_chunks                                     -- vector(384) + an hnsw index
SELECT extname FROM pg_extension WHERE extname = 'vector';
```

The vector index must be **hnsw**, not ivfflat — see the comment at the top of
`migrations/002_indexes.sql` for why that distinction matters.

To confirm the collaborative editor is really persisting (and not just holding
the document in browser memory), read the column `apps/realtime` writes:

```sql
SELECT id, octet_length(crdt_snapshot) AS bytes, updated_at FROM documents;
```

`bytes` should be non-null and grow as you type. The write happens on a
debounce (`FLUSH_DEBOUNCE_MS`, default 5s) and again on the last disconnect
and on SIGTERM, so give it a few seconds after the last keystroke.
`apps/realtime` is the writer of record here; `PUT /documents/{id}/snapshot`
touches the same column and will clobber a live session — see the note in
`apps/api/routers/documents.py`.

## Two projects

The Supabase free tier allows two active projects. Use one for `dev` and one
for `prod` rather than pointing local work at the deployed database.

Free projects **pause after 7 days of inactivity** and need a manual restore
from the dashboard. Data survives, but a portfolio link demoed a month later
will hit a paused project — un-pause it before showing the project, or keep it
warm with a scheduled ping.
