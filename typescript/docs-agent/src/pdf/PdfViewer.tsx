import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type Props = {
  pdf: PDFDocumentProxy;
  /** Fires when the page filling most of the viewport changes. */
  onSectionChange: (index: number) => void;
};

const SCALE = 1.4;

/** Roughly A4 at SCALE — holds the scrollbar honest until the page renders. */
const PLACEHOLDER_HEIGHT = 1120;

function PdfPage({ pdf, pageNumber }: { pdf: PDFDocumentProxy; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Rendering every page of a long PDF up front costs a canvas and a render
  // task each; pages render as they come within reach and stay rendered.
  const [reached, setReached] = useState(pageNumber === 1);

  useEffect(() => {
    if (reached) return;
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setReached(true);
      },
      { rootMargin: '150% 0px' },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [reached]);

  useEffect(() => {
    if (!reached) return;
    let cancelled = false;
    // pdf.js rejects a second render into a canvas that is still busy, so the
    // task is tracked and cancelled rather than just ignored on unmount.
    let task: { cancel: () => void } | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: SCALE * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const render = page.render({ canvasContext: ctx, viewport });
        task = render;
        await render.promise;
      } catch (err) {
        if (!cancelled && (err as { name?: string })?.name !== 'RenderingCancelledException') {
          console.error(`page ${pageNumber} failed to render`, err);
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, reached]);

  return (
    <div
      className="pdf-page"
      data-section={pageNumber - 1}
      ref={frameRef}
      style={reached ? undefined : { minHeight: PLACEHOLDER_HEIGHT }}
    >
      {reached && <canvas ref={canvasRef} />}
      {failed && <p className="err">This page could not be rendered.</p>}
      <span className="pdf-page-no">{pageNumber}</span>
    </div>
  );
}

export function PdfViewer({ pdf, onSectionChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const visibility = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.section);
          visibility.set(index, entry.intersectionRatio);
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
  }, [pdf, onSectionChange]);

  return (
    <div className="doc-scroll" ref={scrollRef}>
      {Array.from({ length: pdf.numPages }, (_, i) => (
        <PdfPage key={i} pdf={pdf} pageNumber={i + 1} />
      ))}
    </div>
  );
}
