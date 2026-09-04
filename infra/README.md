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
there in alphabetical order, so `001` then `002`, on the **first boot of an
empty volume only**. To re-apply after editing:

```sh
docker compose down -v && docker compose up -d
```

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
psql "$SUPABASE_DB_URL" -f infra/supabase/010_auth_sync.sql
psql "$SUPABASE_DB_URL" -f infra/supabase/011_lockdown.sql
```

Pasting into the Supabase SQL editor works too, but running the files keeps
applying the schema a repeatable act rather than a one-off click.

All four are idempotent — re-running them is safe.

### Verify

```sql
\dt                                                  -- six tables
\d source_chunks                                     -- vector(384) + an hnsw index
SELECT extname FROM pg_extension WHERE extname = 'vector';
```

The vector index must be **hnsw**, not ivfflat — see the comment at the top of
`migrations/002_indexes.sql` for why that distinction matters.

## Two projects

The Supabase free tier allows two active projects. Use one for `dev` and one
for `prod` rather than pointing local work at the deployed database.

Free projects **pause after 7 days of inactivity** and need a manual restore
from the dashboard. Data survives, but a portfolio link demoed a month later
will hit a paused project — un-pause it before showing the project, or keep it
warm with a scheduled ping.
