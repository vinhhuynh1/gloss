import quiz
from prompts import build_quiz_prompt
from quiz import _validate_quiz

CHUNKS = [{"id": "c1", "filename": "lec.pdf", "page_ref": "p. 3", "text": "Glycolysis nets 2 ATP."}]
SECTIONS = ["Glycolysis", "Krebs cycle"]


def _question(section="Glycolysis", chunk="c1"):
    return {
        "question": "How many ATP does glycolysis net?",
        "options": ["2", "4", "36", "0"],
        "correct_index": 0,
        "explanation": "It nets two.",
        "source_chunk_id": chunk,
        "section": section,
    }


def _validate(*questions, sections=SECTIONS):
    return _validate_quiz({"title": "T", "questions": list(questions)}, CHUNKS, sections)


def test_keeps_question_with_listed_section():
    out = _validate(_question())
    assert out["questions"][0]["section"] == "Glycolysis"


def test_drops_question_with_unlisted_section():
    assert _validate(_question("Photosynthesis"))["questions"] == []


def test_matches_section_ignoring_case_and_spacing():
    # Review Focus 1: stored under the canonical heading, not the echo.
    out = _validate(_question("  glycolysis "))
    assert out["questions"][0]["section"] == "Glycolysis"


def test_no_section_list_stores_no_section():
    out = _validate(_question("anything"), sections=None)
    assert len(out["questions"]) == 1
    assert "section" not in out["questions"][0]


def test_prompt_lists_sections():
    prompt = build_quiz_prompt("notes", CHUNKS, SECTIONS)
    assert "SECTIONS:\n- Glycolysis\n- Krebs cycle" in prompt


def test_prompt_without_sections_says_none():
    assert "SECTIONS:\n(none given)" in build_quiz_prompt("notes", CHUNKS)


def test_generate_passes_the_headings_not_the_retrieval_blocks(monkeypatch):
    # generate() also splits the notes into blocks for retrieval; those must
    # not be what call_llm validates `section` against.
    seen = {}
    monkeypatch.setattr(quiz, "retrieve_for_notes", lambda *a, **k: CHUNKS)

    def fake_call_llm(notes, chunks, report=None, rng=None, sections=None):
        seen["sections"] = sections
        return {"title": "T", "questions": []}

    monkeypatch.setattr(quiz, "call_llm", fake_call_llm)
    quiz.generate("space", "Glycolysis\n\nNets two ATP per glucose molecule.", sections=SECTIONS)
    assert seen["sections"] == SECTIONS


def test_quiz_lane_stays_off_without_015():
    # Final review, Important 2: claim_next_quiz selects qz.sections, so the
    # lane must not start against a database that has 014 but not 015.
    import worker

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, *a):
            self.answer = "to_regclass" in sql

        def fetchone(self):
            return (self.answer,)

    class Conn:
        def cursor(self):
            return Cursor()

    assert worker.quizzes_available(Conn()) is False
