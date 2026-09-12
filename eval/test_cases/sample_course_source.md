# BIOL 201 — Cellular Respiration (lecture handout)

Sample source material for eval/run_eval.py. Replace this with real course
material once you have a study space built from a course you actually
uploaded slides or a textbook chapter for. Each `##` section below is
ingested as one "page", so the section heading becomes the page_ref shown
in citations — and the page_ref is what `expected_source` in
sample_course.json is graded against.

Two things about this file are deliberate and worth preserving if you edit it:

- **It is long enough that retrieval has to choose.** Fourteen sections
  against `TOP_K = 5` means a query retrieves roughly a third of the corpus,
  so "did the right section come back?" is a real question. An earlier
  four-section version returned the entire corpus on every query, which made
  retrieval recall a constant 1.0 and the eval a test of the prompt alone.
- **Several sections are near-misses for each other.** "Chemiosmosis in
  chloroplasts", "The proton-motive force", and "Substrate-level versus
  oxidative phosphorylation" all crowd the same vector-space neighbourhood as
  "The electron transport chain and chemiosmosis". A retriever that is merely
  reaching for the topic rather than the passage will pick the wrong one, and
  the eval will say so.

A few sections run past `CHUNK_SIZE_CHARS` (1200) on purpose, so that
chunking is exercised and a change to the chunk size or overlap has something
to move.

## Overview of the mitochondrion

The mitochondrion is a double-membraned organelle found in the cytoplasm of
nearly all eukaryotic cells. It is present in both plant and animal cells;
plant cells carry out photosynthesis in chloroplasts *in addition to*
respiration in mitochondria, rather than instead of it. The outer membrane is
smooth and permeable to small molecules, while the inner membrane is folded
into cristae that greatly increase its surface area. The space enclosed by
the inner membrane is called the matrix, and the gap between the two
membranes is the intermembrane space.

Mitochondria are the site of aerobic respiration and produce the large
majority of the cell's ATP. Cells with high energy demands — cardiac muscle,
hepatocytes, neurons — contain correspondingly high numbers of them.

The inner membrane is unusually protein-rich and, crucially, is impermeable
to protons. Every other property of respiration discussed in this handout
depends on that impermeability: a membrane that leaked protons freely could
not hold the gradient that drives ATP synthesis.

## Glycolysis and the link reaction

Glycolysis takes place in the cytosol, not the mitochondrion, and splits one
molecule of glucose into two molecules of pyruvate. It yields a net of 2 ATP
and 2 NADH per glucose and does not require oxygen. The pathway invests 2 ATP
in its early steps and recovers 4, which is why the yield is quoted as a net
figure.

Pyruvate is then transported into the mitochondrial matrix, where the link
reaction (pyruvate decarboxylation) converts each pyruvate into acetyl-CoA,
releasing one CO2 and reducing one NAD+ to NADH per pyruvate. The link
reaction is catalysed by the pyruvate dehydrogenase complex, a large
multi-enzyme assembly, and it is irreversible — once carbon has entered the
mitochondrion as acetyl-CoA it cannot be returned to glucose.

## The Krebs cycle

The Krebs cycle — also called the citric acid cycle or TCA cycle — takes
place in the mitochondrial matrix. Acetyl-CoA condenses with oxaloacetate to
form citrate, which is then oxidised through a series of eight enzymatic
steps that regenerate oxaloacetate. Because oxaloacetate is remade at the end
of every turn, the cycle is catalytic: a small pool of intermediates can
process an unlimited quantity of acetyl-CoA.

Per turn of the cycle (one acetyl-CoA), the yield is 3 NADH, 1 FADH2, 1 GTP
(readily converted to ATP), and 2 CO2. Because each glucose molecule produces
two acetyl-CoA, one glucose drives two turns: 6 NADH, 2 FADH2, 2 ATP, and
4 CO2 in total.

The cycle's real contribution is not the single GTP per turn but the reduced
electron carriers. The NADH and FADH2 generated here carry the electrons that
drive the electron transport chain, which is where the bulk of ATP synthesis
actually happens.

The cycle is regulated at three points — citrate synthase, isocitrate
dehydrogenase, and the alpha-ketoglutarate dehydrogenase complex — all of
which are inhibited by a high NADH/NAD+ ratio. This is the mechanism by which
the cycle slows when the electron transport chain is not consuming its
products fast enough, and it is why the two processes cannot run
independently of one another.

Several Krebs intermediates are also biosynthetic precursors: alpha-
ketoglutarate and oxaloacetate are drawn off for amino acid synthesis, and
succinyl-CoA for haem. The cycle is therefore not purely catabolic, and
intermediates withdrawn for biosynthesis must be replaced by anaplerotic
reactions, most importantly the carboxylation of pyruvate to oxaloacetate.

## The electron transport chain and chemiosmosis

The electron transport chain is a series of four protein complexes embedded
in the inner mitochondrial membrane. NADH donates electrons at Complex I and
FADH2 at Complex II; the electrons pass down the chain through a series of
redox reactions to the final electron acceptor, oxygen, which is reduced to
water. Two mobile carriers shuttle electrons between the complexes:
ubiquinone (coenzyme Q), which is lipid-soluble and moves within the
membrane, and cytochrome c, a small protein on the intermembrane-space face.

As electrons move through Complexes I, III, and IV, protons are pumped from
the matrix into the intermembrane space. Complex II pumps no protons, which
is the structural reason FADH2 yields less ATP than NADH: its electrons enter
downstream of the first pumping site and therefore drive fewer protons across
the membrane.

This generates a proton gradient — an electrochemical potential across the
inner membrane. Protons then flow back into the matrix through ATP synthase,
and that flow drives the synthesis of ATP from ADP and inorganic phosphate.
This coupling of the proton gradient to ATP synthesis is called chemiosmosis,
and the proposal that respiration works this way was Peter Mitchell's, for
which he received the Nobel Prize in 1978.

ATP synthase is a rotary motor. Protons passing through its membrane-embedded
Fo portion turn a rotor, and that rotation drives conformational changes in
the matrix-facing F1 head that release newly formed ATP. Oxidative
phosphorylation yields roughly 26–28 ATP per glucose, giving a total of
approximately 30–32 ATP per glucose across all stages.

## The proton-motive force

The proton gradient the electron transport chain builds has two distinct
components, and treating it as a single quantity obscures where its energy
actually sits. The first is the chemical component: a difference in proton
concentration, expressed as a pH difference of roughly 0.5 to 1.0 units,
with the matrix the more alkaline compartment. The second is the electrical
component: because protons carry charge, pumping them out leaves the matrix
negative relative to the intermembrane space, producing a membrane potential
of about −150 to −180 mV.

The sum of the two is the proton-motive force. In mitochondria the electrical
component dominates, contributing the larger share of the total; the pH
difference is comparatively small. This is the reverse of the situation in
chloroplasts, where the membrane is permeable to the counter-ions that would
otherwise sustain a charge separation.

Roughly four protons are thought to pass through ATP synthase per ATP
synthesised — three to turn the rotor plus one to import phosphate — which is
where the non-integer ATP yields per NADH come from.

## Uncouplers and respiratory control

In a healthy mitochondrion, electron transport and ATP synthesis are
coupled: electrons stop moving down the chain when the gradient is full and
nothing is consuming it. This is respiratory control, and it is why
respiration rate tracks ATP demand rather than running flat out.

An uncoupler breaks that coupling by carrying protons back across the inner
membrane without passing them through ATP synthase. 2,4-dinitrophenol (DNP)
is the classic laboratory example: a weak acid, lipid-soluble in both its
protonated and deprotonated forms, so it ferries protons down their gradient
and short-circuits it. In the presence of an uncoupler, electron transport
accelerates — the gradient it is working against keeps collapsing — oxygen
consumption rises sharply, and ATP synthesis falls. The energy that would
have been captured as ATP is released as heat.

Mammals exploit this deliberately. Brown adipose tissue expresses
thermogenin (UCP1), an inner-membrane protein that provides a regulated
proton leak. Its purpose is heat rather than ATP, which is why brown fat
matters in hibernating mammals and human infants.

DNP was briefly sold as a weight-loss drug in the 1930s and withdrawn after
deaths from hyperthermia; the same mechanism that burns substrate without
producing ATP has no upper limit once the dose is high enough.

## Regulation of glycolysis

Glycolysis is controlled principally at phosphofructokinase-1 (PFK-1), the
enzyme catalysing the committed step — the phosphorylation of fructose
6-phosphate to fructose 1,6-bisphosphate. Because this step commits the
carbon to the pathway, it is the logical control point, and it is a textbook
example of feedback inhibition.

PFK-1 is allosterically inhibited by ATP and by citrate, and activated by AMP
and ADP. The logic is direct: a high ATP concentration means the cell's
energy demand is already met, and citrate accumulating in the cytosol signals
that the Krebs cycle downstream is saturated. A rising AMP concentration is
the opposite signal and accelerates the pathway.

The most potent activator is fructose 2,6-bisphosphate, a regulatory molecule
made by a separate enzyme and not an intermediate of glycolysis at all. It
overrides ATP inhibition, and it is the point at which hormonal control —
insulin and glucagon, acting through that separate enzyme — reaches
glycolysis.

Hexokinase and pyruvate kinase are secondary control points, inhibited by
their own downstream products.

## Fermentation and anaerobic respiration

Without oxygen the electron transport chain stops, NADH is not reoxidised,
and the cell's supply of NAD+ runs out within seconds. Glycolysis then halts
too, because it requires NAD+ as a substrate at its glyceraldehyde
3-phosphate dehydrogenase step. Fermentation exists to solve exactly this
problem: it regenerates NAD+ so glycolysis can continue.

It is important to be clear that fermentation yields no ATP of its own. The
only ATP available anaerobically is the net 2 per glucose from glycolysis —
against roughly 30–32 aerobically. Fermentation is not an alternative energy
pathway; it is a disposal route for electrons that keeps a low-yield one
running.

In animal muscle, pyruvate is reduced to lactate by lactate dehydrogenase.
In yeast and some plant tissue, pyruvate is instead decarboxylated to
acetaldehyde and then reduced to ethanol, releasing CO2 — the reaction behind
brewing and behind the rise of bread dough.

Note the terminology trap: "anaerobic respiration" in the strict sense means
respiration using a final electron acceptor other than oxygen, such as
nitrate or sulfate in certain bacteria, and it does involve an electron
transport chain. Fermentation involves no electron transport chain at all.
Many introductory texts use the two terms interchangeably; this course does
not.

## Substrate-level versus oxidative phosphorylation

Cells make ATP by two mechanically distinct routes, and confusing them is a
common source of error in exam answers.

Substrate-level phosphorylation transfers a phosphate group directly from a
phosphorylated substrate onto ADP, catalysed by a single enzyme. It requires
no membrane, no gradient, and no oxygen. It accounts for the 4 ATP made
during glycolysis and the 1 GTP per turn of the Krebs cycle — 2 ATP and 2 GTP
per glucose respectively, or a small minority of the total.

Oxidative phosphorylation is indirect. No substrate hands a phosphate to ADP;
instead, energy from electron transfer is stored transiently as a proton
gradient and only then converted into ATP by ATP synthase. It requires an
intact, proton-impermeable membrane and, in aerobic organisms, oxygen as the
terminal electron acceptor. It accounts for the large majority of ATP made.

The distinction explains why a cell with damaged mitochondria, or one poisoned
with cyanide at Complex IV, is not left with zero ATP production — the
substrate-level route survives, at roughly a fifteenth of the normal yield.

## Chemiosmosis in chloroplasts

Chloroplasts make ATP by the same chemiosmotic mechanism as mitochondria, and
the parallels are close enough to be worth stating explicitly — and close
enough to be worth keeping distinct.

In the light reactions, electrons flow from water through photosystem II, the
cytochrome b6f complex, and photosystem I, and protons are pumped across the
thylakoid membrane into the thylakoid lumen. ATP synthase in that membrane
then lets them flow back out into the stroma, synthesising ATP. Because the
process is driven by light rather than by the oxidation of a fuel, it is
called photophosphorylation.

The geometry is the mirror image of the mitochondrial case. In a
mitochondrion protons are pumped out of the matrix and ATP is made as they
return to it; in a chloroplast protons are pumped into the lumen and ATP is
made as they leave it. ATP synthase's catalytic head faces the matrix in one
and the stroma in the other, and in both cases ATP appears in the compartment
where the rest of the pathway needs it.

The thylakoid membrane is also permeable to counter-ions such as Mg2+ and
Cl−, which move to neutralise the charge separation. The consequence is that
almost all of the chloroplast proton-motive force is a pH gradient — the
lumen can drop to around pH 5 against a stroma near pH 8 — with very little
membrane potential, the opposite of the mitochondrial balance.

## Photosynthesis compared

Photosynthesis and respiration are often taught as inverse processes, and to
a first approximation the overall equations do reverse one another:
photosynthesis consumes CO2 and water and produces glucose and oxygen, while
respiration consumes glucose and oxygen and produces CO2 and water.

The symmetry is only approximate. The two run in different organelles, use
different carriers — NADPH for the reductive biosynthesis of photosynthesis,
NADH for the oxidative catabolism of respiration — and the carbon-fixing
Calvin cycle in the stroma is not a reversal of the Krebs cycle in any
meaningful sense.

Plant cells run both simultaneously. In daylight, photosynthesis in the
chloroplasts typically outpaces respiration in the mitochondria, so a plant
is a net oxygen producer over a day; at night only respiration continues. A
plant cell that lost its mitochondria would not survive on photosynthesis
alone, because the chloroplast makes ATP only in the light and only in the
stroma, where the rest of the cell cannot draw on it.

## Total ATP accounting

The commonly quoted figure of 38 ATP per glucose is an idealisation that
assumes whole-number yields of 3 ATP per NADH and 2 per FADH2. Measured
proton stoichiometries give roughly 2.5 ATP per NADH and 1.5 per FADH2, and
the modern figure is therefore approximately 30–32.

Building the total from the stages: glycolysis contributes 2 ATP directly and
2 NADH; the link reaction 2 NADH; the Krebs cycle 2 ATP (as GTP), 6 NADH, and
2 FADH2. That is 4 ATP by substrate-level phosphorylation, 10 NADH, and
2 FADH2 per glucose. At 2.5 and 1.5 respectively, the reduced carriers are
worth 25 + 3 = 28, for a total near 32.

The range rather than a single number comes from the two glycolytic NADH,
which are made in the cytosol and cannot cross the inner membrane. Their
electrons are carried in by one of two shuttles, and which one operates
depends on the tissue. The glycerol 3-phosphate shuttle, used in skeletal
muscle and brain, delivers them to ubiquinone via FADH2 and so yields 1.5 ATP
each. The malate-aspartate shuttle, used in liver, kidney, and heart,
delivers them as matrix NADH and yields 2.5 each. The two-ATP difference
between the shuttles is the whole of the 30-versus-32 discrepancy.

All of these figures are upper bounds in any case. Some of the proton-motive
force is spent importing phosphate and pyruvate rather than making ATP, and
the inner membrane has a small natural proton leak, so the yield measured in
an intact cell is lower than the stoichiometry predicts.

## Mitochondrial DNA and endosymbiotic theory

Mitochondria carry their own genome, separate from the nuclear one. The human
mitochondrial genome is a circular molecule of about 16,600 base pairs
encoding 37 genes: 13 proteins, all subunits of the respiratory complexes,
plus 22 transfer RNAs and 2 ribosomal RNAs. The remaining roughly 1,500
mitochondrial proteins are encoded in the nucleus, synthesised in the
cytosol, and imported.

The endosymbiotic theory accounts for this arrangement: the mitochondrion
descends from a free-living alpha-proteobacterium engulfed by an ancestral
host cell. The supporting evidence is structural as much as genetic — the
double membrane, with the inner membrane resembling a bacterial plasma
membrane in its lipid composition; a circular genome with no histones;
ribosomes of the bacterial 70S type rather than the eukaryotic 80S, which is
why some antibiotics that target bacterial ribosomes have mitochondrial side
effects; and division by binary fission rather than by any nuclear-directed
process.

In humans, mitochondrial DNA is inherited maternally: the egg contributes the
zygote's mitochondria and the sperm's are destroyed after fertilisation. This
gives mitochondrial disorders a distinctive inheritance pattern — an affected
mother passes the condition to all of her children, an affected father to
none of his.

Severity is complicated by heteroplasmy. A cell contains many mitochondrial
genomes, and a mutation may be present in some and not others; disease
appears only once the mutant fraction passes a threshold, which differs by
tissue according to how much the tissue depends on oxidative
phosphorylation. Nerve and muscle are affected earliest for that reason.

## Measuring respiration in the laboratory

Respiration rate is measured as oxygen consumption, and the classical
instrument is the Clark oxygen electrode: a platinum cathode and silver
anode behind an oxygen-permeable membrane in a sealed, stirred chamber. It
reports dissolved oxygen continuously, so the trace is a rate rather than an
endpoint.

The standard experiment adds reagents in sequence to a suspension of isolated
mitochondria and reads the slope after each. Substrate alone gives a slow
baseline rate; adding ADP gives a fast rate as ATP synthesis consumes the
gradient; and the ratio of the two, the respiratory control ratio, measures
how well coupled the preparation is. A low ratio means damaged or leaky
mitochondria. Adding an uncoupler gives the maximum rate the chain can
sustain, and a Complex IV inhibitor such as cyanide or azide stops
consumption altogether.

A second measure is the respiratory quotient, the ratio of CO2 produced to
O2 consumed. It is 1.0 for carbohydrate, about 0.7 for fat, and around 0.8
for protein, so it indicates which fuel is being oxidised. Whole-organism
respirometry uses the same principle, absorbing the CO2 produced so that the
volume change reflects oxygen uptake alone.
