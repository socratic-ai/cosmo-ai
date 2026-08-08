import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// Vite resolves this to a URL for the bundled worker, so no CDN and no
// copy-to-public step.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import type { DocumentSource } from '../document';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type LoadedPdf = {
  pdf: PDFDocumentProxy;
  doc: DocumentSource;
};

/** Renders nothing — this only opens the file and pulls the text layer, which
 *  is what the agent needs. Pixels are the viewer's job. */
export async function loadPdf(file: File): Promise<LoadedPdf> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;

  const sections = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, i) => {
      const page = await pdf.getPage(i + 1);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { index: i, label: `Page ${i + 1}`, text };
    }),
  );

  const metadata = await pdf.getMetadata().catch(() => null);
  const info = metadata?.info as { Title?: string } | undefined;
  const title = info?.Title?.trim() || file.name;

  return { pdf, doc: { kind: 'pdf', title, origin: file.name, sections } };
}
