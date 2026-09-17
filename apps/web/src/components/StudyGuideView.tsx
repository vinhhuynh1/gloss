/**
 * The generated study guide, and the thing that gets printed.
 *
 * Citations are numbered rather than inlined as "(lecture-3.pdf, p. 12)" after
 * every point. A revision guide is read in one pass, and repeating the same
 * filename down the page costs more attention than it returns; a number
 * against each point and one Sources list at the end says the same thing and
 * leaves the points readable.
 *
 * The excerpt is printed with each source deliberately. A citation nobody can
 * check is decoration — the whole argument for this project is that every line
 * traces to something in the course material, and on paper there is no
 * expanding a <details> to find out.
 */
import type { Guide, GuidePoint, GuideTerm } from "../lib/types";

/** Sources in citation order, and the number to print against each point.
 *
 * Keyed on chunk id: two points grounded in the same excerpt share a number,
 * which is what makes the Sources list short enough to be worth reading. */
function numberSources(guide: Guide) {
  const order: (GuidePoint | GuideTerm)[] = [
    ...guide.sections.flatMap((s) => s.points),
    ...guide.key_terms,
  ];
  const numbers = new Map<string, number>();
  const sources: { n: number; item: GuidePoint | GuideTerm }[] = [];
  for (const item of order) {
    if (numbers.has(item.source_chunk_id)) continue;
    const n = numbers.size + 1;
    numbers.set(item.source_chunk_id, n);
    sources.push({ n, item });
  }
  return { numbers, sources };
}

function sourceLabel(item: GuidePoint | GuideTerm): string {
  return (
    [item.source_filename, item.source_page_ref].filter(Boolean).join(", ") ||
    "course material"
  );
}

export default function StudyGuideView({
  guide,
  generatedAt,
  onClose,
}: {
  guide: Guide;
  generatedAt: string | null;
  onClose: () => void;
}) {
  const { numbers, sources } = numberSources(guide);

  return (
    <div className="study-guide">
      {/* Hidden in print via @media print — a toolbar on paper is wasted ink. */}
      <div className="study-guide-actions">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <button className="link-button" onClick={onClose}>
          Back to notes
        </button>
      </div>

      <article className="study-guide-sheet">
        <h1>{guide.title}</h1>
        {generatedAt && (
          <p className="muted">
            Generated {new Date(generatedAt).toLocaleString()} from this study
            space's notes and sources.
          </p>
        )}

        {guide.sections.map((section, i) => (
          <section key={i}>
            <h2>{section.heading}</h2>
            <ul>
              {section.points.map((point, j) => (
                <li key={j}>
                  {point.text}{" "}
                  <sup className="cite">{numbers.get(point.source_chunk_id)}</sup>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {guide.key_terms.length > 0 && (
          <section>
            <h2>Key terms</h2>
            <dl>
              {guide.key_terms.map((term, i) => (
                <div key={i}>
                  <dt>{term.term}</dt>
                  <dd>
                    {term.definition}{" "}
                    <sup className="cite">{numbers.get(term.source_chunk_id)}</sup>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="study-guide-sources">
          <h2>Sources</h2>
          <ol>
            {sources.map(({ n, item }) => (
              <li key={n}>
                <span className="source-label">{sourceLabel(item)}</span>
                {item.source_excerpt && (
                  <blockquote>{item.source_excerpt}</blockquote>
                )}
              </li>
            ))}
          </ol>
        </section>
      </article>
    </div>
  );
}
