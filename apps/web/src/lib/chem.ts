/**
 * Chemical formulas as they are printed: H₂SO₄, Ca(OH)₂, Fe³⁺, A ⇌ B.
 *
 * Done with Unicode sub- and superscript characters rather than markup, so
 * the result is ordinary text: it goes into the Yjs document like anything
 * typed, prints, copies and searches, and needs no extension in the editor.
 *
 * The prompts ask the model for these characters directly. This catches what
 * it writes anyway, "H2O" and "Fe^{3+}", and answers written before it was
 * asked.
 */

const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
};
const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻",
};

// Longest first, so "Cl" is tried before "C".
const ELEMENTS = (
  "He Li Be Ne Na Mg Al Si Cl Ar Ca Sc Ti Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr " +
  "Rb Sr Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd " +
  "Tb Dy Ho Er Tm Yb Lu Hf Ta Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa " +
  "Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og " +
  "H B C N O F P S K V Y I W U"
).split(" ");

const UNIT = `(?:${ELEMENTS.join("|")})\\d*`;
// A whole word made only of element symbols, counts and parentheses, with an
// optional leading coefficient: "2H2O", "Ca(OH)2". Only a word with a count
// in it is touched, so "In", "He" and "NO" in a sentence stay words.
const FORMULA_RE = new RegExp(
  `(?<![A-Za-z0-9])(\\d*)((?:${UNIT}|\\((?:${UNIT})+\\)\\d*)+)(?![A-Za-z0-9])`,
  "g"
);
// "^2-", "^{3+}", "^+": a charge or an exponent, after the thing it belongs to.
const SUP_RE = /(?<=[A-Za-z0-9)\]₀-₉])\^\{?(\d*[+\-−]|\d+)\}?/g;
// "_2", "_{12}": a count written the LaTeX way.
const SUB_RE = /(?<=[A-Za-z)\]])_\{?(\d+)\}?/g;

const map = (s: string, table: Record<string, string>) =>
  [...s].map((ch) => table[ch] ?? ch).join("");

export function formatChem(text: string): string {
  return (
    text
      .replace(/<=>|<->/g, "⇌")
      .replace(/(?<![<-])->/g, "→")
      // Charges first: the formula pass turns "SO4" into "SO₄", and the
      // charge after it must still see "^2-" rather than a subscript.
      .replace(SUP_RE, (_, s: string) => map(s, SUP))
      .replace(SUB_RE, (_, s: string) => map(s, SUB))
      .replace(FORMULA_RE, (whole, coefficient: string, formula: string) =>
        /\d/.test(formula) ? coefficient + map(formula, SUB) : whole
      )
  );
}
