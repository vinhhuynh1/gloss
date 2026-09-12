# Eval log

What each change did to the agent's score, newest first.

The build plan asks for this log specifically: *"Re-run this set every time you
change the prompt, the chunking strategy, or the retrieval top_k, and keep a
short log of what each change did to the score. That log is the artifact worth
showing in an interview — not just a working demo, but 'here's what I tried,
here's what moved the number.'"*

## How to add an entry

Run the eval, then compare against the previous run:

```powershell
$env:STUDY_SPACE_ID="<uuid>"; python eval/run_eval.py --compare latest
```

Every run writes a record to `eval/results/` holding the config it ran under —
model, prompt hash, `top_k`, chunk size and overlap, embedding model, and a
fingerprint of the corpus. Those records are committed, so a line in this log
can always be traced to the code and material that produced it. Cite the record
filename in the entry.

One entry per change, and **change one thing at a time** — two edits in a run
produce one number and no information. An entry is worth more for the failure
modes it names than for the percentage: write down which cases moved and why,
not just that the score went up.

A template:

```
## YYYY-MM-DD — what changed

Record: `results/<timestamp>.json` (compared with `<earlier>.json`)

| metric | before | after |
|---|---|---|
| type accuracy | | |
| flag precision | | |
| flag recall | | |
| grounding accuracy | | |
| retrieval recall@k | | |

Cases that moved: ...

Notes on failure modes: ...
```

---

## 2026-09-12 — order `citation` ahead of `gap_fill`

Record: `results/2026-09-12T04-58-06+00-00.json` (compared with
`results/2026-09-12T03-43-53+00-00.json`). Only `prompt_sha256` changed.
137.4s, 60,861 in / 8,513 out (~$0.52).

Not another threshold — a precedence rule, added after the four type
definitions. Ask first whether the passage already makes the claim; if it does,
the notes are not missing it and the most you can add is the source, however
much more the excerpt goes on to say. `gap_fill` only where the passage does not
make the claim at all.

| metric | before | after | |
|---|---|---|---|
| type accuracy | 61% | 72% | **+11** |
| type accuracy (lenient) | 61% | 72% | +11 |
| flag precision | 80% | 80% | = |
| flag recall | 100% | 100% | = |
| grounding accuracy | 92% | 92% | = |
| retrieval recall@k | 92% | 92% | = |

Cases that moved: `cite-substrate-level` and `cite-rq-fat`, both FAIL→PASS.

Notes on failure modes: it returned exactly the 11 points the chunker fix cost,
and it returned them without giving back any precision — which is the result
that makes the previous entry's reading correct. The regression was never in the
chunker; it was an ordering the prompt had not specified, exposed by a corpus
that put more substance in front of the model.

The `citation` row went `0/0/0/4` → `0/2/0/2`. Recovered `cite-substrate-level`
and `cite-rq-fat`; `cite-proton-gradient` and `cite-brown-fat` still answer
`gap_fill`. In both of those the passage makes a *partial* claim the excerpt then
extends — the proton gradient treated as one undifferentiated quantity, brown fat
named without its mechanism — so "does the passage already make the claim" is
genuinely ambiguous rather than being ignored. A sharper rule would have to say
what counts as making a claim *fully*, and that is a rewrite rather than a clause.

**Where this leaves the agent** (five runs, ~$2.33, against the baseline):

| metric | baseline | now | |
|---|---|---|---|
| type accuracy | 67% | 72% | +5 |
| flag precision | 71% | 80% | +9 |
| flag recall | 100% | 100% | = |
| grounding accuracy | 83% | 92% | +9 |
| retrieval recall@k | 92% | 92% | = |

…on a corpus that is also 22% smaller (27 → 21 chunks) for the same coverage.

All five remaining failures are the same shape: `gap_fill` firing where it should
not — three `none` cases and the two partial-claim `citation` cases. It has been
the residual failure mode through every run in this log, and it survived two
direct attempts on it, which is the argument for the next thing being a change of
kind rather than another clause. Two candidates: drop `gap_fill` to a
lower-confidence class that needs a stronger signal than the others, or give the
test set more `none` cases so the bar is measured rather than argued — six of
eighteen is thin for the one behaviour that keeps breaking.

Retrieval never moved across any run: recall@k sat at 92% from first to last,
with the same single case (`gap-uncouplers`) mis-grounded throughout. Every point
gained here came from the prompt. That is worth knowing before spending anything
on the retriever.

## 2026-09-12 — fix the sliver chunks (a regression)

Record: `results/2026-09-12T03-43-53+00-00.json` (compared with
`results/2026-09-12T03-30-36+00-00.json`). Config identical; **the corpus
changed** — 27 chunks → 21, new fingerprint. 122.8s, 58,359 in / 7,295 out
(~$0.47).

`ingest.chunk_text()` now stops once a chunk reaches the end of the text instead
of stepping back by the overlap, removing the six duplicate tails (32–186 chars)
that sections of 1000–1200 characters were emitting.

| metric | before | after | |
|---|---|---|---|
| type accuracy | 72% | 61% | **−11** |
| type accuracy (lenient) | 72% | 61% | −11 |
| flag precision | 86% | 80% | −6 |
| flag recall | 100% | 100% | = |
| grounding accuracy | 92% | 92% | = |
| retrieval recall@k | 92% | 92% | = |

Cases that moved: `none-already-cited` and `cite-substrate-level`, both
PASS→FAIL.

Notes on failure modes: the change is correct and the score got worse, so both
facts go in the log. Note first what did **not** move: grounding and retrieval
recall@k are identical at 92%. Removing the slivers did not improve retrieval by
either measure the harness has — the predicted effect simply is not there at
this corpus size.

What it did instead is change what `top_k=5` *contains*. With the duplicate tails
gone, five results are five distinct full passages rather than four passages and
some fragments, so every call now carries more substantive material — and more
material reads as more missing from the notes. The `citation` row completed its
collapse: `0/1/0/3` → `0/0/0/4`. **Every citation case is now answered
`gap_fill`**, and a third `none` case joined them.

That is the same unresolved ambiguity the previous entry named, amplified rather
than caused by this change: nothing in the prompt orders `citation` against
`gap_fill`, so any increase in retrieved substance pushes verdicts toward
`gap_fill`. The chunker is not what is wrong here.

Keeping the change: duplicate tails are waste on their own terms — they cost
embedding storage and can out-rank the passage they were cut from — and the
regression they expose is a prompt problem with a queued fix. Reverting would
hide it and buy 11 points of accuracy that the next change should return
legitimately.

The `--compare` corpus warning fired correctly here, and it is the reason this
entry can say "config identical, material changed" rather than guessing.

## 2026-09-12 — the same bar on `citation`

Record: `results/2026-09-12T03-30-36+00-00.json` (compared with
`results/2026-09-12T03-24-56+00-00.json`). Only `prompt_sha256` changed.
119.2s, 56,009 in / 6,729 out (~$0.45).

Redefined `citation` to require a specific, checkable claim — a number, a
mechanism, a named structure — stated directly by an excerpt and not already
attributed, with the escape hatch named explicitly: almost every correct
sentence in a set of notes is supported by the source somewhere, and that is not
enough.

| metric | before | after | | vs. baseline |
|---|---|---|---|---|
| type accuracy | 67% | 72% | +6 | +6 |
| type accuracy (lenient) | 89% | 72% | **−17** | = |
| flag precision | 75% | 86% | **+11** | **+15** |
| flag recall | 100% | 100% | = | = |
| grounding accuracy | 92% | 92% | = | +8 |
| retrieval recall@k | 92% | 92% | = | = |

Cases that moved: `none-correct-restatement`, `none-already-cited`,
`gap-krebs-yield`, `gap-mtdna-heteroplasmy` all FAIL→PASS; `cite-proton-gradient`,
`cite-brown-fat`, `cite-rq-fat` all PASS→FAIL.

Notes on failure modes: **the see-saw tipped the other way.** Change 1 squeezed
`gap_fill` and the overflow went into `citation`; this squeezed `citation` and
the overflow went straight back into `gap_fill`. The `citation` row went
`0/4/0/0` → `0/1/0/3` — three of the four real citation cases are now answered
`gap_fill`. That is also why lenient accuracy fell 17 points while strict rose:
the errors moved from pairs the test set forgives into pairs it does not.

What the two runs together bought is nonetheless real, and it is all on the axis
the baseline said was broken: **precision 71% → 86%, recall unmoved at 100%,
grounding 83% → 92%.** The `none` row is now `4/0/0/2`, against `1/2/0/3` at
baseline — the agent has largely stopped flagging passages that should be left
alone. Only `none-vague-but-not-wrong` and `none-correct-fermentation` remain,
both as `gap_fill`.

But the failure mode has changed identity, and the next change should not be
another bar. The agent now flags very nearly the right *set* of passages and
picks the wrong *label* between "cite this" and "add this" — because the two
definitions overlap and nothing orders them. A passage that states a claim an
excerpt supports simultaneously satisfies `citation` (the claim is uncited) and
`gap_fill` (the excerpt's detail is absent). Whichever definition is looser at
the time wins, which is exactly the oscillation these two runs traced.

Queued next, and the biggest remaining lever at 3 cases: give the two a
precedence rule rather than a threshold — if the passage already makes the
claim, it is `citation`; `gap_fill` only where the passage does not make it at
all. Precision should hold and type accuracy should take the gain.

## 2026-09-12 — a bar on `gap_fill`

Record: `results/2026-09-12T03-24-56+00-00.json` (compared with
`results/2026-09-12T03-17-28+00-00.json`). Only `prompt_sha256` changed.
125.8s, 54,227 in / 6,711 out (~$0.44).

Redefined `gap_fill` in `AGENT_SYSTEM_PROMPT` from "the excerpts cover a topic
the passage does not mention" to "the passage leaves out something belonging to
the subject it is itself about", and stated the negative case outright: the
excerpts are retrieved in bulk and will always contain material the notes omit,
which on its own is not a gap.

| metric | before | after | |
|---|---|---|---|
| type accuracy | 67% | 67% | = |
| type accuracy (lenient) | 72% | 89% | **+17** |
| flag precision | 71% | 75% | +4 |
| flag recall | 100% | 100% | = |
| grounding accuracy | 83% | 92% | +8 |
| retrieval recall@k | 92% | 92% | = |

Cases that moved: `none-outside-knowledge-trap` FAIL→PASS,
`cite-proton-gradient` FAIL→PASS, `gap-krebs-yield` PASS→FAIL,
`gap-mtdna-heteroplasmy` PASS→FAIL. Strict accuracy is unchanged because those
cancel exactly; everything real happened in the other four numbers.

Notes on failure modes: **the change worked and the predicted mechanism was
wrong**, which is the useful part. `gap_fill` false flags fell 3 → 1 as intended,
but they did not become `none` — they became `citation`. The `none` row went
`1/2/0/3` → `2/3/0/1`: one more correct `none`, one more false `citation`. Net
false positives only 5 → 4, hence the modest +4 precision against +17 lenient.

The same pressure pushed two *correct* `gap_fill` verdicts into `citation`
(`gap-krebs-yield`, `gap-mtdna-heteroplasmy`). Both list `citation` in
`also_acceptable`, so they cost strict accuracy and not lenient — the bar is
slightly too high, or `citation` is simply the path of least resistance.

Either way the conclusion is the same and it sharpens the next change: squeezing
`gap_fill` just relocates the over-flagging, because **`citation` is an
unconditional escape hatch** — "a claim an excerpt supports, with no citation
yet" is true of any correct sentence in the notes. It is now the binding
constraint on precision, and queued change 2 goes straight at it.

Flag recall held at 100% throughout, which was the risk being watched.

## 2026-09-12 — queued change 1 dropped before it was run

Record: none. The evidence is the baseline below,
`results/2026-09-12T03-17-28+00-00.json`.

The change was to state in `AGENT_SYSTEM_PROMPT` the rule `agent._validate()`
enforces, predicted to raise flag recall and cut the `ungrounded_suggestion`
count. The baseline shows both already at their limits:

| predicted lever | baseline | headroom |
|---|---|---|
| flag recall | 100% | none — it cannot rise |
| `ungrounded_suggestion` | 0 | none — it never fires |

The entire `none`-reasons breakdown is `model_said_none: 1`: across 18 cases no
verdict was downgraded by a guard at all. The change would have measured a null,
so it was dropped rather than spend a run on it.

The inconsistency it describes is real — the prompt still does not state the rule
the code enforces — but it is cosmetic rather than a scoring problem, and belongs
in a change that claims no score movement.

Notes on failure modes: this is the log working in the cheapest direction it can.
The prediction was written before any number existed, and the first number
falsified it. Worth more than the run it saved.

## 2026-09-12 — baseline

Record: `results/2026-09-12T03-17-28+00-00.json` (no earlier run to compare with)

`claude-opus-5`, `top_k` 5, chunks 1200/200, 27 chunks over the 14 sections of
`sample_course_source.md`, 18 cases. 126s, 52,229 in / 7,588 out tokens (~$0.45).

| metric | value |
|---|---|
| type accuracy | 67% (lenient 72%) |
| flag precision | 71% |
| flag recall | 100% |
| grounding accuracy | 83% (12 graded) |
| retrieval recall@k | 92% (12 graded) |

Confusion matrix (rows expected, columns got):

| | none | cite | contr | gap |
|---|---|---|---|---|
| **none** | 1 | 2 | 0 | 3 |
| **citation** | 0 | 3 | 0 | 1 |
| **contradiction** | 0 | 0 | 4 | 0 |
| **gap_fill** | 0 | 0 | 0 | 4 |

`none` verdicts by reason: `model_said_none: 1`. No `ungrounded_suggestion`, no
`hallucinated_chunk`, no `invalid_type`, no `refusal`.

Notes on failure modes: every error is the same error. The agent flagged **5 of
the 6 passages that should have been left alone**, and missed nothing it should
have caught. That asymmetry — recall 100%, precision 71% — is the whole story.

Its reasoning on each false flag is coherent, which is the tell that the prompt
is at fault rather than the model: *"the excerpt covers substantial adjacent
material … that the notes omit entirely"* (`none-correct-fermentation`).
`gap_fill` is defined as the excerpts covering a topic the passage does not
mention, and retrieval always returns five chunks covering more than any one
passage — so the condition is satisfied on every call and there is no bar to
clear. Three of the five false flags are that. The other two are `citation`,
whose definition is unconditional in the same way: a correct-but-uncited passage
always qualifies.

Grounding's two misses: `gap-uncouplers` cited "The electron transport chain and
chemiosmosis" rather than "Uncouplers and respiratory control", and
`cite-proton-gradient` cited "The proton-motive force" rather than "The electron
transport chain and chemiosmosis" — both neighbours of the right section, not
wild citations.

## Queued — changes to measure, in this order

Three candidates, in this order. The first two come out of the baseline's one
real failure mode — the agent will not stay quiet — and they are deliberately
kept apart even though they are the same idea applied twice, because run
together they would move flag precision by an amount neither could claim.

**1. Put a bar on `gap_fill`.**
It is defined as the excerpts covering a topic the passage does not mention,
which retrieval guarantees on every call. Require instead that the missing
material be within the subject the passage is already about, and say the
negative case outright: the excerpts will always contain something the notes
omit, and that alone is not a gap. This targets 3 of the 5 false flags.
Arithmetic to check the outcome against: 12 true positives and 5 false
positives today, so clearing those three without losing a real `gap_fill` gives
80% precision, and losing one gives 73%. **Watch flag recall in the same
breath** — it is at 100%, this change can only cost it, and a precision gain
that guts recall is a worse agent.

**2. Put the same bar on `citation`.**
Only after 1 is logged. "A claim an excerpt supports, but with no citation yet"
is satisfied by any correct sentence in the notes. A passage that merely
restates a source in general terms should not qualify. The case this genuinely
targets is `none-vague-but-not-wrong`; `none-correct-restatement` lists
`citation` in `also_acceptable` and already scores as a lenient pass.

**3. Fix the sliver chunks in `ingest.chunk_text()`.**
The loop advances `start = end - CHUNK_OVERLAP_CHARS` and continues while
`start < len(text)`, so a section between `CHUNK_SIZE_CHARS - CHUNK_OVERLAP_CHARS`
(1000) and `CHUNK_SIZE_CHARS` (1200) long emits a second chunk wholly contained
in the first. On the current corpus that is 6 of 27 chunks — the six sections of
1032 to 1186 characters, whose duplicate tails run 32, 50, 85, 93, 94 and 186
characters. (The seven sections over 1200 characters also emit a second chunk,
but it carries text the first one does not; those are working as intended.) A
short sliver can out-rank the full passage for a short query and then grounds a
citation in an excerpt with no context, which is exactly the "cites confidently
but wrongly" failure the eval exists to catch.

The fix is to stop once a chunk reaches the end of the text, taking the corpus
from 27 chunks to 21. It changes chunking, so it needs a re-seed
(`python seed_demo.py`) and therefore changes the corpus fingerprint —
`--compare` will flag that, correctly. Expect retrieval recall@k and grounding
accuracy to move; type accuracy may not.
