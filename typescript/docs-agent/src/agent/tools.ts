import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

import { documentPayload, searchDocument, sectionPayload, type DocumentState } from '../document';

/** Live state, not a snapshot: the reader scrolls and re-selects constantly,
 *  and re-declaring tools would mean restarting the session. */
export type StateRef = { current: DocumentState | null };

const MAX_HITS = 8;

function requireState(ref: StateRef): DocumentState {
  const state = ref.current;
  if (!state) throw new Error('No document is open yet — ask the reader to open a PDF or a link.');
  return state;
}

export function makeDocumentTools(ref: StateRef) {
  const getCurrentView = tool({
    name: 'get_current_view',
    description:
      'What the reader is looking at right now: the section they have scrolled to, its full text, and any text they have selected. Call this before answering anything about "this", "here", or "the current page".',
    input: zodInput(z.object({})),
    handler: async () => {
      const { doc, view } = requireState(ref);
      const section = doc.sections[view.sectionIndex];
      return {
        documentTitle: doc.title,
        sectionIndex: view.sectionIndex,
        totalSections: doc.sections.length,
        selection: view.selection,
        ...(section ? sectionPayload(section) : { label: 'unknown', text: '', truncated: false }),
      };
    },
  });

  const getSection = tool({
    name: 'get_section',
    description:
      'Full text of one section by its zero-based index (for a PDF, index 0 is page 1). Use get_outline first if you need to know what the sections are.',
    input: zodInput(
      z.object({
        index: z.number().int().min(0).describe('Zero-based section index'),
      }),
    ),
    handler: async ({ index }) => {
      const { doc } = requireState(ref);
      const section = doc.sections[index];
      if (!section) {
        throw new Error(`There is no section ${index}; this document has ${doc.sections.length}.`);
      }
      return { sectionIndex: index, ...sectionPayload(section) };
    },
  });

  const readDocument = tool({
    name: 'read_document',
    description:
      'The full text of the whole document, section by section. Use this for anything that needs the document as a whole — what it is, what it says overall, summarising it, or a question whose answer could be anywhere. Prefer it over reading sections one at a time.',
    input: zodInput(z.object({})),
    handler: async () => {
      const { doc } = requireState(ref);
      const { text, truncated } = documentPayload(doc);
      return {
        documentTitle: doc.title,
        kind: doc.kind,
        totalSections: doc.sections.length,
        text,
        truncated,
        ...(truncated
          ? { note: 'Too long to return whole; use search_document and get_section for the rest.' }
          : {}),
      };
    },
  });

  const searchTool = tool({
    name: 'search_document',
    description:
      'Find where a phrase appears in the document. Returns matching snippets with their section indices, which you can then read in full with get_section. Matching is literal, so search for distinctive words rather than paraphrases.',
    input: zodInput(
      z.object({
        query: z.string().min(1).describe('Literal text to look for'),
        limit: z.number().int().min(1).max(MAX_HITS).default(5),
      }),
    ),
    handler: async ({ query, limit }) => {
      const { doc } = requireState(ref);
      const hits = searchDocument(doc, query, limit);
      return { query, matches: hits, matchCount: hits.length };
    },
  });

  const getOutline = tool({
    name: 'get_outline',
    description: 'The list of sections in the document, with their indices and labels. Cheap — no body text.',
    input: zodInput(z.object({})),
    handler: async () => {
      const { doc, view } = requireState(ref);
      return {
        documentTitle: doc.title,
        kind: doc.kind,
        currentSectionIndex: view.sectionIndex,
        sections: doc.sections.map((s) => ({
          index: s.index,
          label: s.label,
          characters: s.text.length,
        })),
      };
    },
  });

  return [getCurrentView, readDocument, getSection, searchTool, getOutline];
}
