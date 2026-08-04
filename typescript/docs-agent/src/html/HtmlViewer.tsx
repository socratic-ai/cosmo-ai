import { useEffect, useRef } from 'react';

type Props = {
  /** Sanitized markup, one entry per document section, from `/local/fetch-url`. */
  blocks: string[];
  onSectionChange: (index: number) => void;
};

/**
 * The markup arrives already sanitized by the server (no scripts, styles,
 * iframes, forms or event handlers) and is rendered into this document
 * rather than a sandboxed iframe: a cross-origin iframe would hide both the
 * user's text selection and their scroll position, which are exactly what
 * the agent needs. Sanitization is the security boundary — never render
 * markup here that did not come from `/local/fetch-url`.
 */
export function HtmlViewer({ blocks, onSectionChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const visibility = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibility.set(Number((entry.target as HTMLElement).dataset.section), entry.intersectionRatio);
        }
        let best = -1;
        let bestRatio = 0;
        for (const [index, ratio] of visibility) {
          if (ratio > bestRatio) {
            best = index;
            bestRatio = ratio;
          }
        }
        if (best >= 0) onSectionChange(best);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of root.querySelectorAll('[data-section]')) observer.observe(el);
    return () => observer.disconnect();
  }, [blocks, onSectionChange]);

  return (
    <div className="doc-scroll" ref={scrollRef}>
      <article className="html-body">
        {blocks.map((block, i) => (
          <section key={i} data-section={i} dangerouslySetInnerHTML={{ __html: block }} />
        ))}
      </article>
    </div>
  );
}
