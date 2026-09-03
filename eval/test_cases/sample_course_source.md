# BIOL 201 — Cellular Respiration (lecture handout)

Sample source material for eval/run_eval.py. Replace this with real course
material once you have a study space built from a course you actually
uploaded slides or a textbook chapter for. Each `##` section below is
ingested as one "page", so the section heading becomes the page_ref shown
in citations.

## Overview of the mitochondrion

The mitochondrion is a double-membraned organelle found in the cytoplasm of
nearly all eukaryotic cells. It is present in both plant and animal cells;
plant cells carry out photosynthesis in chloroplasts *in addition to*
respiration in mitochondria, rather than instead of it. The outer membrane is
smooth and permeable to small molecules, while the inner membrane is folded
into cristae that greatly increase its surface area. The space enclosed by
the inner membrane is called the matrix.

Mitochondria are the site of aerobic respiration and produce the large
majority of the cell's ATP. Cells with high energy demands — cardiac muscle,
hepatocytes, neurons — contain correspondingly high numbers of them.

## Glycolysis and the link reaction

Glycolysis takes place in the cytosol, not the mitochondrion, and splits one
molecule of glucose into two molecules of pyruvate. It yields a net of 2 ATP
and 2 NADH per glucose and does not require oxygen.

Pyruvate is then transported into the mitochondrial matrix, where the link
reaction (pyruvate decarboxylation) converts each pyruvate into acetyl-CoA,
releasing one CO2 and reducing one NAD+ to NADH per pyruvate.

## The Krebs cycle

The Krebs cycle — also called the citric acid cycle or TCA cycle — takes
place in the mitochondrial matrix. Acetyl-CoA condenses with oxaloacetate to
form citrate, which is then oxidised through a series of eight enzymatic
steps that regenerate oxaloacetate.

Per turn of the cycle (one acetyl-CoA), the yield is 3 NADH, 1 FADH2, 1 GTP
(readily converted to ATP), and 2 CO2. Because each glucose molecule produces
two acetyl-CoA, one glucose drives two turns: 6 NADH, 2 FADH2, 2 ATP, and
4 CO2 in total.

The cycle's real contribution is not the single GTP per turn but the reduced
electron carriers. The NADH and FADH2 generated here carry the electrons that
drive the electron transport chain, which is where the bulk of ATP synthesis
actually happens.

## The electron transport chain and chemiosmosis

The electron transport chain is a series of four protein complexes embedded
in the inner mitochondrial membrane. NADH donates electrons at Complex I and
FADH2 at Complex II; the electrons pass down the chain through a series of
redox reactions to the final electron acceptor, oxygen, which is reduced to
water.

As electrons move through Complexes I, III, and IV, protons are pumped from
the matrix into the intermembrane space. This generates a proton gradient —
an electrochemical potential across the inner membrane. Protons then flow
back into the matrix through ATP synthase, and that flow drives the synthesis
of ATP from ADP and inorganic phosphate. This coupling of the proton gradient
to ATP synthesis is called chemiosmosis.

Oxidative phosphorylation yields roughly 26–28 ATP per glucose, giving a
total of approximately 30–32 ATP per glucose across all stages.
