"""
Runs the agent against a hand-written test set and reports how it did.

Re-run this after every change to the prompt, the chunking strategy, or the
retrieval top_k — those are the three knobs the build plan names — and add a
line to eval/CHANGELOG.md saying what the change did to the score. Every run
also drops a JSON record in eval/results/ carrying the config it ran under,
so a number in that log can always be traced back to the code that produced
it.

Usage:
    STUDY_SPACE_ID=<uuid> python run_eval.py [path-to-test-cases.json]
    python run_eval.py --compare latest
    python run_eval.py --judge

(PowerShell: `$env:STUDY_SPACE_ID="<uuid>"; python run_eval.py`)

The study space must already have source material ingested — run
apps/agent-worker/seed_demo.py to build one from the sample source, or
ingest.py to build one from a real PDF.

What gets scored
----------------
The build plan asks for three things: did it flag what it should have, did it
stay quiet where it should have, and do its citations actually point at a
passage that supports the claim. The third is the one it calls the failure
mode that matters most, and it is the reason a case carries `expected_source`.

Those become five numbers:

  type accuracy      the headline — did the verdict match, plus a confusion
                     matrix, because "it answers `none` to everything" and
                     "it guesses wildly" are the same accuracy and different
                     problems
  flag precision     of the passages it flagged, how many deserved flagging
  flag recall        of the passages that deserved flagging, how many it caught
  grounding          of the verdicts it did make, how many cite the right
                     section
  retrieval recall@k was the right section even in the retrieved set?

The last two are deliberately separate. Grounding low while recall@k is high
is a prompt problem; recall@k low is a retrieval problem, and no amount of
prompt work will fix it. That is the same split apps/agent-worker/search.py
exists to let you make by hand.

This harness observes the agent, it does not reimplement it. It calls
check_passage() — the same entry point worker.py uses — so a score here is a
statement about the code that actually runs in the app.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "agent-worker"))
import agent  # noqa: E402
from agent import check_passage, cited_chunk  # noqa: E402
from embeddings import MODEL_NAME as EMBEDDING_MODEL  # noqa: E402
from ingest import CHUNK_OVERLAP_CHARS, CHUNK_SIZE_CHARS  # noqa: E402
from prompts import AGENT_SYSTEM_PROMPT  # noqa: E402
from retrieval import DATABASE_URL  # noqa: E402

TEST_CASES_DIR = Path(__file__).parent / "test_cases"
DEFAULT_TEST_CASES = TEST_CASES_DIR / "sample_course.json"
RESULTS_DIR = Path(__file__).parent / "results"

TYPES = ("none", "citation", "contradiction", "gap_fill")
# Abbreviations for the confusion matrix, which has to fit in a terminal.
ABBREV = {"none": "none", "citation": "cite", "contradiction": "contr", "gap_fill": "gap"}

# agent._validate() rewrites a verdict to `none` for several distinct reasons,
# and the reasoning string is the only thing that says which. Telling them
# apart matters: a real "no confident suggestion" is the agent working, while a
# hallucinated chunk id or an uncited suggestion is the agent being caught by a
# guard — same score, different fix. Matched on substrings of the messages in
# agent.py; if those are reworded, these stop classifying and fall through to
# "model_said_none", which is visible rather than silent.
DOWNGRADE_MARKERS = {
    "invalid type from model": "invalid_type",
    "model cited a chunk that was not retrieved": "hallucinated_chunk",
    "without citing an excerpt": "ungrounded_suggestion",
    "model declined to answer": "refusal",
}


# --------------------------------------------------------------------------
# Config capture
# --------------------------------------------------------------------------

def _git_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).parent,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def corpus_info(study_space_id: str) -> dict:
    """What is actually in the study space being scored against.

    Recorded with every run because a score is only comparable to another
    score taken over the same material. Re-seeding from an edited source file
    changes the corpus without changing a line of agent code, and without this
    fingerprint a --compare across that boundary would blame the prompt for a
    move the corpus caused.
    """
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*), COUNT(DISTINCT s.id)
                  FROM source_chunks sc
                  JOIN sources s ON s.id = sc.source_id
                 WHERE s.study_space_id = %s
                """,
                (study_space_id,),
            )
            chunk_count, source_count = cur.fetchone()
            cur.execute(
                """
                SELECT DISTINCT sc.page_ref
                  FROM source_chunks sc
                  JOIN sources s ON s.id = sc.source_id
                 WHERE s.study_space_id = %s AND sc.page_ref IS NOT NULL
                """,
                (study_space_id,),
            )
            page_refs = sorted(row[0] for row in cur.fetchall())

    return {
        "chunk_count": chunk_count,
        "source_count": source_count,
        "page_ref_count": len(page_refs),
        "fingerprint": _sha256(f"{chunk_count}|" + "|".join(page_refs)),
    }, set(page_refs)


class UsageRecorder:
    """Best-effort token accounting, without changing agent.py.

    call_llm() returns a verdict, not the response object, so usage is not
    reachable from the outside — but "what did this run cost" is a fair
    question once you are sweeping. Rather than widen the agent's return type
    for the benefit of the eval, this wraps the SDK's create() for the
    duration of the run and puts it back afterwards.

    It reaches into SDK internals, so it is written to fail soft: if the
    wrapper will not attach, every token count is None and the run is
    otherwise unaffected.
    """

    def __init__(self):
        self.calls: list[tuple[int | None, int | None]] = []
        self._messages = None
        self._original = None

    def __enter__(self):
        try:
            self._messages = agent._get_client().beta.messages
            self._original = self._messages.create

            def recording_create(*args, **kwargs):
                response = self._original(*args, **kwargs)
                usage = getattr(response, "usage", None)
                self.calls.append(
                    (
                        getattr(usage, "input_tokens", None),
                        getattr(usage, "output_tokens", None),
                    )
                )
                return response

            self._messages.create = recording_create
        except Exception:
            self._messages = self._original = None
        return self

    def __exit__(self, *exc):
        if self._messages is not None and self._original is not None:
            try:
                self._messages.create = self._original
            except Exception:
                pass
        return False

    def drain(self) -> tuple[int | None, int | None]:
        """Total usage since the last drain, or (None, None) if unavailable.

        Summed rather than popped because --judge makes a second call for the
        same case; charging that case only the last call would quietly bill
        the agent's tokens to the judge.
        """
        if not self.calls:
            return (None, None)
        calls, self.calls = self.calls, []
        return (
            sum(c[0] or 0 for c in calls),
            sum(c[1] or 0 for c in calls),
        )


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------

def classify_none(reasoning: str | None) -> str:
    lowered = (reasoning or "").lower()
    for marker, label in DOWNGRADE_MARKERS.items():
        if marker in lowered:
            return label
    return "model_said_none"


def score_case(case: dict, verdict: dict, chunks: list[dict]) -> dict:
    """One case's outcome. Pure — takes what the agent returned, decides nothing."""
    expected = case["expected_type"]
    expected_source = case.get("expected_source")
    got = verdict["type"]
    chunk = cited_chunk(verdict, chunks)
    cited_page_ref = chunk["page_ref"] if chunk else None

    # Was the section that should back this case retrieved at all? Decided
    # from the retrieved set alone, so it is a measurement of retrieval with
    # the model's judgment taken out of it.
    retrieval_hit = (
        expected_source in {c["page_ref"] for c in chunks}
        if expected_source
        else None
    )

    # Gradable only when the case names a section and the agent actually made
    # a suggestion. An agent that flags a `none` case has nothing to be graded
    # against and is already penalised by type accuracy and flag precision;
    # counting it as a grounding miss too would charge one error twice.
    if expected_source and got != "none":
        grounded = cited_page_ref == expected_source
    else:
        grounded = None

    return {
        "id": case["id"],
        "expected_type": expected,
        "got_type": got,
        "correct": got == expected,
        "lenient_correct": got == expected or got in case.get("also_acceptable", []),
        "expected_source": expected_source,
        "cited_page_ref": cited_page_ref,
        "grounded": grounded,
        "retrieval_hit": retrieval_hit,
        "none_reason": classify_none(verdict.get("reasoning")) if got == "none" else None,
        "proposed_text": verdict.get("proposed_text", ""),
        "reasoning": verdict.get("reasoning", ""),
        "error": None,
    }


def aggregate(results: list[dict]) -> dict:
    total = len(results)
    scored = [r for r in results if r["error"] is None]

    tp = sum(1 for r in scored if r["expected_type"] != "none" and r["got_type"] != "none")
    fp = sum(1 for r in scored if r["expected_type"] == "none" and r["got_type"] != "none")
    fn = sum(1 for r in scored if r["expected_type"] != "none" and r["got_type"] == "none")

    grounded = [r["grounded"] for r in scored if r["grounded"] is not None]
    recalled = [r["retrieval_hit"] for r in scored if r["retrieval_hit"] is not None]

    def ratio(num, den):
        return round(num / den, 4) if den else None

    return {
        "cases": total,
        "errored": total - len(scored),
        "type_accuracy": ratio(sum(r["correct"] for r in scored), len(scored)),
        "type_accuracy_lenient": ratio(
            sum(r["lenient_correct"] for r in scored), len(scored)
        ),
        "flag_precision": ratio(tp, tp + fp),
        "flag_recall": ratio(tp, tp + fn),
        "grounding_accuracy": ratio(sum(grounded), len(grounded)),
        "grounding_graded": len(grounded),
        "retrieval_recall_at_k": ratio(sum(recalled), len(recalled)),
        "retrieval_graded": len(recalled),
        "none_reasons": dict(
            Counter(r["none_reason"] for r in scored if r["none_reason"])
        ),
    }


def confusion(results: list[dict]) -> dict:
    matrix = defaultdict(Counter)
    for r in results:
        if r["error"] is None:
            matrix[r["expected_type"]][r["got_type"]] += 1
    return {e: dict(c) for e, c in matrix.items()}


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

def print_confusion(matrix: dict) -> None:
    print("\nConfusion matrix (rows expected, columns got):")
    header = "  " + "".join(f"{ABBREV[t]:>7}" for t in TYPES)
    print(f"{'':>16}{header}")
    for expected in TYPES:
        row = matrix.get(expected, {})
        cells = "".join(f"{row.get(got, 0):>7}" for got in TYPES)
        print(f"{expected:>16}  {cells}")


def _pct(value) -> str:
    return "  n/a" if value is None else f"{value:.0%}"


def print_metrics(metrics: dict) -> None:
    print("\nScores:")
    print(f"  type accuracy        {_pct(metrics['type_accuracy'])}"
          f"   (lenient {_pct(metrics['type_accuracy_lenient'])})")
    print(f"  flag precision       {_pct(metrics['flag_precision'])}"
          "   of what it flagged, how much deserved it")
    print(f"  flag recall          {_pct(metrics['flag_recall'])}"
          "   of what deserved flagging, how much it caught")
    print(f"  grounding accuracy   {_pct(metrics['grounding_accuracy'])}"
          f"   cited the right section ({metrics['grounding_graded']} graded)")
    print(f"  retrieval recall@k   {_pct(metrics['retrieval_recall_at_k'])}"
          f"   right section retrieved ({metrics['retrieval_graded']} graded)")

    if metrics["none_reasons"]:
        print("\n  `none` verdicts by reason:")
        for reason, count in sorted(metrics["none_reasons"].items()):
            print(f"    {reason:<24} {count}")

    grounding = metrics["grounding_accuracy"]
    recall = metrics["retrieval_recall_at_k"]
    if grounding is not None and recall is not None:
        if recall < 0.8:
            print("\n  -> retrieval is the bottleneck: the right section often isn't")
            print("     even being retrieved, so prompt changes cannot fix this.")
            print("     Check apps/agent-worker/search.py, top_k, and chunk size.")
        elif grounding < 0.8:
            print("\n  -> the right section is being retrieved but not cited:")
            print("     that is a prompt problem, not a retrieval one.")


def print_errors(results: list[dict]) -> None:
    errored = [r for r in results if r["error"]]
    if errored:
        print(f"\n{len(errored)} case(s) errored and are excluded from the scores:")
        for r in errored:
            print(f"  {r['id']}: {r['error']}")


# --------------------------------------------------------------------------
# Run records
# --------------------------------------------------------------------------

def write_record(record: dict) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = record["run"]["timestamp"].replace(":", "-").replace("+00:00", "Z")
    path = RESULTS_DIR / f"{stamp}.json"
    path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return path


def load_record(spec: str, exclude: Path | None = None) -> dict | None:
    """Resolve --compare: either `latest` or a path to a run record."""
    if spec == "latest":
        candidates = sorted(
            p for p in RESULTS_DIR.glob("*.json") if p.resolve() != (exclude and exclude.resolve())
        )
        if not candidates:
            print("\nNo earlier run in eval/results/ to compare against.")
            return None
        path = candidates[-1]
    else:
        path = Path(spec)
        if not path.exists():
            print(f"\nNo such run record: {path}")
            return None
    record = json.loads(path.read_text(encoding="utf-8"))
    record["_path"] = str(path)
    return record


def print_comparison(current: dict, previous: dict) -> None:
    print(f"\n{'=' * 68}")
    print(f"Compared with {previous['_path']}")

    prev_run, curr_run = previous["run"], current["run"]
    changed = [
        (key, prev_run.get(key), curr_run.get(key))
        for key in ("model", "prompt_sha256", "top_k", "chunk_size", "chunk_overlap",
                    "embedding_model", "test_cases_file")
        if prev_run.get(key) != curr_run.get(key)
    ]
    prev_corpus = prev_run.get("corpus", {}).get("fingerprint")
    curr_corpus = curr_run.get("corpus", {}).get("fingerprint")

    if changed:
        print("\nConfig changed:")
        for key, before, after in changed:
            print(f"  {key}: {before} -> {after}")
    else:
        print("\nConfig identical.")

    if prev_corpus != curr_corpus:
        print("\n  !! The corpus also changed between these runs. Any score move")
        print("     below is a change in the material as much as in the agent —")
        print("     re-run the earlier config against this corpus before")
        print("     attributing the difference to anything else.")

    print("\nMetrics:")
    for key in ("type_accuracy", "type_accuracy_lenient", "flag_precision",
                "flag_recall", "grounding_accuracy", "retrieval_recall_at_k"):
        before, after = previous["metrics"].get(key), current["metrics"].get(key)
        if before is None and after is None:
            continue
        arrow = ""
        if before is not None and after is not None:
            delta = after - before
            arrow = f"  {'+' if delta > 0 else ''}{delta:.0%}" if delta else "   ="
        print(f"  {key:<24} {_pct(before)} -> {_pct(after)}{arrow}")

    before_by_id = {c["id"]: c for c in previous["cases"]}
    moved = []
    for case in current["cases"]:
        was = before_by_id.get(case["id"])
        if was and was["correct"] != case["correct"]:
            moved.append((case["id"], was["correct"], case["correct"]))

    if moved:
        print("\nCases that moved:")
        for case_id, was_correct, now_correct in moved:
            direction = "FAIL -> PASS" if now_correct else "PASS -> FAIL"
            print(f"  {direction}  {case_id}")
    else:
        print("\nNo individual case changed verdict.")

    only_now = {c["id"] for c in current["cases"]} - set(before_by_id)
    only_before = set(before_by_id) - {c["id"] for c in current["cases"]}
    if only_now or only_before:
        print("\n  Note: the test set itself changed, so the totals are not")
        print("  strictly comparable.")
        for case_id in sorted(only_now):
            print(f"    added:   {case_id}")
        for case_id in sorted(only_before):
            print(f"    removed: {case_id}")


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

def run(test_cases_path: Path, study_space_id: str, use_judge: bool = False) -> dict:
    data = json.loads(test_cases_path.read_text(encoding="utf-8"))
    cases = data["cases"]

    corpus, page_refs = corpus_info(study_space_id)
    if corpus["chunk_count"] == 0:
        sys.exit(
            f"""Study space {study_space_id} has no source chunks.

Every case would be scored against an empty retrieval, which measures
nothing. Seed it first:
    cd apps/agent-worker && python seed_demo.py"""
        )

    # A case graded against a section the corpus does not contain can never
    # pass, and the failure looks like an agent problem rather than a stale
    # study space. Say so before spending a single model call on it.
    expected_sources = {c["expected_source"] for c in cases if c.get("expected_source")}
    missing = sorted(expected_sources - page_refs)
    if missing:
        print("WARNING: these expected_source values are not page_refs in this")
        print("study space — it was probably seeded from an older source file:")
        for ref in missing:
            print(f"  - {ref}")
        print("Re-seed with: cd apps/agent-worker && python seed_demo.py\n")

    judge_fn = None
    if use_judge:
        from judge import judge_grounding

        judge_fn = judge_grounding

    print(f"{len(cases)} cases against {corpus['chunk_count']} chunks "
          f"in {corpus['source_count']} source(s), top_k={agent.TOP_K}, "
          f"model={agent.ANTHROPIC_MODEL}\n")

    results = []
    started = time.perf_counter()

    with UsageRecorder() as usage:
        for case in cases:
            case_started = time.perf_counter()
            try:
                verdict, chunks = check_passage(study_space_id, case["notes_passage"])
                if verdict is None:
                    raise RuntimeError("no source material retrieved for this space")
                result = score_case(case, verdict, chunks)
                if judge_fn and verdict["type"] != "none":
                    chunk = cited_chunk(verdict, chunks)
                    result["judge"] = judge_fn(
                        case["notes_passage"], verdict, chunk
                    ) if chunk else None
            except Exception as exc:  # one bad case must not end an 18-case run
                result = {
                    "id": case["id"],
                    "expected_type": case["expected_type"],
                    "got_type": None,
                    "correct": False,
                    "lenient_correct": False,
                    "expected_source": case.get("expected_source"),
                    "cited_page_ref": None,
                    "grounded": None,
                    "retrieval_hit": None,
                    "none_reason": None,
                    "proposed_text": "",
                    "reasoning": "",
                    "error": f"{type(exc).__name__}: {exc}",
                }

            tokens_in, tokens_out = usage.drain()
            result["latency_ms"] = round((time.perf_counter() - case_started) * 1000)
            result["input_tokens"] = tokens_in
            result["output_tokens"] = tokens_out
            results.append(result)

            if result["error"]:
                print(f"[ERR ] {result['id']}: {result['error']}")
            else:
                status = "PASS" if result["correct"] else (
                    "pass*" if result["lenient_correct"] else "FAIL"
                )
                ground = ""
                if result["grounded"] is not None:
                    ground = "  grounded" if result["grounded"] else (
                        f"  MIS-GROUNDED (cited {result['cited_page_ref']!r})"
                    )
                elif result["retrieval_hit"] is False:
                    ground = "  (right section not retrieved)"
                print(f"[{status}] {result['id']}: expected={result['expected_type']} "
                      f"got={result['got_type']}{ground}")

    wall_ms = round((time.perf_counter() - started) * 1000)
    metrics = aggregate(results)
    matrix = confusion(results)

    print_errors(results)
    print_confusion(matrix)
    print_metrics(metrics)

    if use_judge:
        judged = [r["judge"] for r in results if r.get("judge")]
        supported = sum(1 for j in judged if j.get("supported"))
        if judged:
            print(f"\n  judge: {supported}/{len(judged)} cited excerpts actually "
                  f"support the suggestion ({supported / len(judged):.0%})")

    token_totals = [
        (r["input_tokens"] or 0, r["output_tokens"] or 0)
        for r in results
        if r["input_tokens"] is not None
    ]
    tokens = {
        "input": sum(t[0] for t in token_totals) or None,
        "output": sum(t[1] for t in token_totals) or None,
    }
    print(f"\n  {wall_ms / 1000:.1f}s total"
          + (f", {tokens['input']} in / {tokens['output']} out tokens"
             if tokens["input"] else ""))

    return {
        "run": {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "git_sha": _git_sha(),
            "model": agent.ANTHROPIC_MODEL,
            "prompt_sha256": _sha256(AGENT_SYSTEM_PROMPT),
            "top_k": agent.TOP_K,
            "chunk_size": CHUNK_SIZE_CHARS,
            "chunk_overlap": CHUNK_OVERLAP_CHARS,
            "embedding_model": EMBEDDING_MODEL,
            "test_cases_file": test_cases_path.name,
            "course_name": data.get("course_name"),
            "study_space_id": study_space_id,
            "corpus": corpus,
            "judge": use_judge,
            "wall_ms": wall_ms,
            "tokens": tokens,
        },
        "metrics": metrics,
        "confusion": matrix,
        "cases": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Score the agent against a hand-written test set.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "test_cases", nargs="?", default=str(DEFAULT_TEST_CASES),
        help="path to a test-cases JSON file",
    )
    parser.add_argument(
        "--compare", metavar="PATH|latest",
        help="diff this run against an earlier run record in eval/results/",
    )
    parser.add_argument(
        "--judge", action="store_true",
        help="also ask the model whether each cited excerpt supports the "
             "suggestion (one extra call per non-none verdict)",
    )
    parser.add_argument(
        "--no-save", action="store_true",
        help="skip writing a run record to eval/results/",
    )
    args = parser.parse_args()

    study_space_id = os.getenv("STUDY_SPACE_ID")
    if not study_space_id:
        sys.exit(
            """STUDY_SPACE_ID is not set.

It must name a study space that already has source material ingested —
the retrieval query is scoped to it, so an empty space retrieves nothing
and every case scores wrong.

To build one from the sample source material:
    cd apps/agent-worker && python seed_demo.py
then re-run the eval with the study_space_id it prints:
    STUDY_SPACE_ID=<uuid> python run_eval.py
    $env:STUDY_SPACE_ID="<uuid>"; python run_eval.py   # PowerShell"""
        )

    record = run(Path(args.test_cases), study_space_id, use_judge=args.judge)

    written = None
    if not args.no_save:
        written = write_record(record)
        print(f"\nRun record: {written}")
        print("Add a line to eval/CHANGELOG.md saying what changed and what it did.")

    if args.compare:
        previous = load_record(args.compare, exclude=written)
        if previous:
            print_comparison(record, previous)


if __name__ == "__main__":
    main()
