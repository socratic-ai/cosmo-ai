/**
 * One document model for both renderers, so the agent's tools never need to
 * know whether they are looking at a PDF or a web page.
 */

export type DocSection = {
  index: number;
  /** Human-facing name — "Page 3" for a PDF, the heading for a web page. */
  label: string;
  text: string;
};

export type DocumentSource = {
  kind: 'pdf' | 'html';
  title: string;
  /** Where the document came from: a filename, or the fetched URL. */
  origin: string;
  sections: DocSection[];
};

/** Where the reader is right now — the tools read this, never a snapshot. */
export type ReaderView = {
  sectionIndex: number;
  selection: string | null;
};

export type DocumentState = {
  doc: DocumentSource;
  view: ReaderView;
};

const SNIPPET_RADIUS = 220;

export type SearchHit = {
  sectionIndex: number;
  label: string;
  snippet: string;
};

export function searchDocument(doc: DocumentSource, query: string, limit: number): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const section of doc.sections) {
    const haystack = section.text.toLowerCase();
    let from = 0;
    while (hits.length < limit) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const start = Math.max(0, at - SNIPPET_RADIUS);
      const end = Math.min(section.text.length, at + needle.length + SNIPPET_RADIUS);
      hits.push({
        sectionIndex: section.index,
        label: section.label,
        snippet:
          (start > 0 ? '…' : '') +
          section.text.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < section.text.length ? '…' : ''),
      });
      from = at + needle.length;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Long sections are truncated before they reach the model — a 40-page PDF
 *  page is fine, a single-section article can be enormous. */
const MAX_SECTION_CHARS = 12_000;

/** Short enough that the whole thing rides in the prompt and the agent can
 *  answer without a tool call at all. A one-page form is the common case. */
export const INLINE_BUDGET = 14_000;

/** The ceiling on a single `read_document` reply — above this the agent has to
 *  work section by section. */
const MAX_DOCUMENT_CHARS = 45_000;

export function documentCharacters(doc: DocumentSource): number {
  return doc.sections.reduce((total, section) => total + section.text.length, 0);
}

export function documentText(doc: DocumentSource): string {
  return doc.sections.map((section) => `## ${section.label}\n${section.text}`).join('\n\n');
}

export function documentPayload(doc: DocumentSource): { text: string; truncated: boolean } {
  const full = documentText(doc);
  const truncated = full.length > MAX_DOCUMENT_CHARS;
  return { text: truncated ? `${full.slice(0, MAX_DOCUMENT_CHARS)}…` : full, truncated };
}

export function sectionPayload(section: DocSection): { label: string; text: string; truncated: boolean } {
  const truncated = section.text.length > MAX_SECTION_CHARS;
  return {
    label: section.label,
    text: truncated ? `${section.text.slice(0, MAX_SECTION_CHARS)}…` : section.text,
    truncated,
  };
}
