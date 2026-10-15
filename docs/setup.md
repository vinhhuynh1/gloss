# Local setup

Postgres, four services, then the eval. Start them in this order — each depends on the one before it.

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
   and leave it running. It does three jobs:
   - turns files uploaded in the web app into searchable chunks,
   - answers **Check with AI** — select a passage in the notes and click the
     button (or Ctrl/Cmd+Alt+M), and the worker retrieves from that space's
     sources, asks the model, and writes back a suggestion that appears
     highlighted in the doc and as a card in the sidebar, and
   - writes a **Study guide** — the whole notes document turned into a
     revision sheet where every point carries the source excerpt it came
     from, laid out for the browser's print-to-PDF.

   Without it, uploads sit at "Queued", checks at "Checking…" and guides at
   "Writing study guide…" forever — every panel says so after a few seconds,
   because it is the easiest thing to forget. Checks are claimed first, then
   guides, then uploads; but one worker does one thing at a time, so a check
   asked for while a long PDF is mid-ingest waits for it to finish.

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
   to `eval/CHANGELOG.md` each time — one change at a time is the only way
   it means anything.

   `--judge` adds a second model call per suggestion asking whether the cited
   excerpt really supports it. Useful for auditing a run before you write it
   up; not something to hillclimb against, since the judge drifts too.

> Testing collaboration in two tabs of the **same** browser profile proves
> nothing: y-websocket syncs same-origin tabs directly over BroadcastChannel,
> so they stay in sync even with the realtime server stopped. Use two browsers,
> or one normal and one private window — ideally signed in as two users.

## Checks

The same ones CI runs (`.github/workflows/ci.yml`). The Python tests need the
Postgres from step 1 and write to it, cleaning up after themselves; stop the
agent worker first, or it will claim the quizzes the tests create.

```sh
ruff check apps/api apps/agent-worker eval      # config in ruff.toml
cd apps/api && pytest -q
cd apps/agent-worker && pytest -q
cd apps/web && npm run lint && npm run typecheck && npm test
```
