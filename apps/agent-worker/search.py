"""
Query the vector store by hand.

    python search.py <study_space_id> "what is the electron transport chain"
    python search.py <study_space_id> "..." --top-k 10 --full

This is the sanity check the build plan asks for at the end of week 3: a PDF
is only really ingested once you can ask the corpus a question and get back
passages that genuinely answer it. It runs the same retrieval the agent runs
(retrieval.py) and stops before the LLM, which is the point — when a
suggestion comes out wrong, this separates "retrieval handed the model the
wrong passages" from "the model did the wrong thing with the right ones", and
those have opposite fixes.

Nothing here calls the Anthropic API, so it costs nothing to run in a loop
while tuning CHUNK_SIZE_CHARS or TOP_K.
"""
import argparse

import psycopg

from retrieval import DATABASE_URL, DEFAULT_TOP_K, search

SNIPPET_CHARS = 300


def corpus_summary(study_space_id: str) -> list[tuple[str, str, int]]:
    """(filename, status, chunk count) per source, so an empty result set can
    be told apart from an empty corpus — the two look identical at the prompt
    and have completely different causes."""
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT s.filename, s.status, count(sc.id)
                  FROM sources s
             LEFT JOIN source_chunks sc ON sc.source_id = s.id
                 WHERE s.study_space_id = %s
              GROUP BY s.id, s.filename, s.status
              ORDER BY s.uploaded_at
                """,
                (study_space_id,),
            )
            return cur.fetchall()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study_space_id")
    parser.add_argument("query")
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument(
        "--full", action="store_true", help="print whole chunks, not snippets"
    )
    args = parser.parse_args()

    sources = corpus_summary(args.study_space_id)
    if not sources:
        raise SystemExit(
            "This study space has no source material. Upload a file in the web "
            "app (and run worker.py), or ingest one directly with ingest.py."
        )

    total_chunks = sum(count for _, _, count in sources)
    print(f"Corpus: {len(sources)} source(s), {total_chunks} chunk(s)")
    for filename, status, count in sources:
        note = "" if status == "ready" else f"  <- {status}"
        print(f"  {count:>5} chunks  {filename}{note}")

    if not total_chunks:
        raise SystemExit(
            "\nEvery source is still unprocessed. Is worker.py running?"
        )

    print(f"\nQuery: {args.query!r}\n")
    results = search(args.study_space_id, args.query, args.top_k)

    for rank, hit in enumerate(results, start=1):
        where = hit["page_ref"] or "no locator"
        text = hit["text"] if args.full else hit["text"][:SNIPPET_CHARS].strip()
        if not args.full and len(hit["text"]) > SNIPPET_CHARS:
            text += "…"
        print(f"{rank}. score {hit['score']:.3f}  {hit['filename']} — {where}")
        print(f"   {text}\n")

    # Read this before reading the passages themselves. Scores clustered low
    # across all K means the material does not cover the question, and no
    # amount of prompt work fixes that — it is a "upload the right chapter"
    # problem, not an agent problem.
    if results:
        print(f"Best score {results[0]['score']:.3f}, worst {results[-1]['score']:.3f}")


if __name__ == "__main__":
    main()
