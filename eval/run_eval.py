"""
Runs the agent against a hand-written test set and reports how it did.
Re-run this after every change to the prompt, chunking strategy, or top_k —
see the "Evaluation approach" section of the build-plan doc. Keep a short
log elsewhere (a CHANGELOG.md, a spreadsheet, whatever) of what each change
did to the score; that log is the artifact worth showing in an interview.

Usage:
    python run_eval.py [path-to-test-cases.json]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "agent-worker"))
from agent import call_llm, retrieve_chunks  # noqa: E402

DEFAULT_TEST_CASES = Path(__file__).parent / "test_cases" / "sample_course.json"


def run(test_cases_path: Path, study_space_id: str):
    data = json.loads(test_cases_path.read_text())
    cases = data["cases"]

    correct = 0
    results = []

    for case in cases:
        chunks = retrieve_chunks(study_space_id, case["notes_passage"])
        result = call_llm(case["notes_passage"], chunks)
        is_correct = result["type"] == case["expected_type"]
        correct += is_correct
        results.append(
            {
                "id": case["id"],
                "expected": case["expected_type"],
                "got": result["type"],
                "correct": is_correct,
            }
        )
        status = "PASS" if is_correct else "FAIL"
        print(f"[{status}] {case['id']}: expected={case['expected_type']} got={result['type']}")

    score = correct / len(cases)
    print(f"\nScore: {correct}/{len(cases)} ({score:.0%})")
    return results, score


if __name__ == "__main__":
    test_cases_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TEST_CASES
    # TODO: replace with a real study_space_id that has ingested source
    # material matching the test cases (see apps/agent-worker/ingest.py).
    STUDY_SPACE_ID = "TODO-real-study-space-id"
    run(test_cases_path, STUDY_SPACE_ID)
