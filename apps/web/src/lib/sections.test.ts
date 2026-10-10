import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { headingEntries, sectionHeadings, sectionText } from "./sections";

const schema = getSchema([StarterKit]);
const h = (level: number, text: string) => ({
  type: "heading",
  attrs: { level },
  content: text ? [{ type: "text", text }] : [],
});
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

const doc = schema.nodeFromJSON({
  type: "doc",
  content: [
    p("Intro before any heading."),
    h(1, "Glycolysis"),
    p("Nets two ATP."),
    h(2, "Steps"),
    p("Ten steps."),
    h(1, ""),
    h(1, "Krebs cycle"),
    p("Eight steps."),
    h(2, "glycolysis"),
    p("Revisited."),
  ],
});

describe("sections", () => {
  it("skips empty headings", () => {
    expect(headingEntries(doc).map((e) => e.text)).toEqual([
      "Glycolysis",
      "Steps",
      "Krebs cycle",
      "glycolysis",
    ]);
  });

  it("dedupes heading text ignoring case, first spelling wins", () => {
    expect(sectionHeadings(doc)).toEqual(["Glycolysis", "Steps", "Krebs cycle"]);
  });

  it("a section runs to the next heading of any level", () => {
    expect(sectionText(doc, ["Steps"])).toBe("Steps\n\nTen steps.");
  });

  it("collects every occurrence of a merged heading", () => {
    expect(sectionText(doc, ["GLYCOLYSIS"])).toBe(
      "Glycolysis\n\nNets two ATP.\n\nglycolysis\n\nRevisited."
    );
  });

  it("returns nothing for a heading that is not there", () => {
    expect(sectionText(doc, ["Photosynthesis"])).toBe("");
  });
});

describe("overlong headings", () => {
  it("skips a heading the API would refuse", () => {
    const long = "x".repeat(201);
    const d = schema.nodeFromJSON({
      type: "doc",
      content: [h(1, "Glycolysis"), p("a"), h(1, long), p("b")],
    });
    expect(sectionHeadings(d)).toEqual(["Glycolysis"]);
  });
});
