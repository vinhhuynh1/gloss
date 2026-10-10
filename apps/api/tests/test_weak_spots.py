from weak_spots import score_answers, tally

QUESTIONS = [{"correct_index": 0}, {"correct_index": 1}, {"correct_index": 2}]


def test_score_counts_matches():
    assert score_answers(QUESTIONS, [0, 1, 0]) == 2


def test_tally_groups_by_section():
    rows = [([0, 0, 2], ["A", "A", "B"], [0, 1, 2])]
    by = {r["section"]: r for r in tally(rows)}
    assert (by["A"]["asked"], by["A"]["correct"]) == (2, 1)
    assert (by["B"]["asked"], by["B"]["correct"]) == (1, 1)


def test_needs_two_asked_to_be_weak():
    assert tally([([1], ["A"], [0])])[0]["weak"] is False


def test_seventy_percent_exactly_is_not_weak():
    rows = [([0] * 7 + [1] * 3, ["A"] * 10, [0] * 10)]
    assert tally(rows)[0]["weak"] is False


def test_below_seventy_is_weak():
    rows = [([0] * 6 + [1] * 4, ["A"] * 10, [0] * 10)]
    assert tally(rows)[0]["weak"] is True


def test_misaligned_row_is_skipped():
    assert tally([([0, 1], ["A"], [0, 1])]) == []


def test_weakest_first():
    rows = [([0, 0, 1, 1], ["Good", "Good", "Bad", "Bad"], [0, 0, 0, 0])]
    assert [r["section"] for r in tally(rows)] == ["Bad", "Good"]
