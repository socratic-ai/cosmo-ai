/** Client for the Cosmo board-vision endpoint: a board image in, its FEN
 *  placement out. The heavy lifting (piece detection, orientation and
 *  legality resolution) happens server-side — this app never runs a vision
 *  model. */

export type BoardOrientation = 'white' | 'black';

/** Mirrors the endpoint's response, which is the same shape the backend's
 *  board-reading tool has always returned. */
export type BoardPositionResult = {
  status: 'ok' | 'unreadable' | 'uncertain' | 'error';
  /** FEN placement field only (no side-to-move). */
  placement?: string | null;
  orientation?: BoardOrientation | null;
  coach_hint?: string;
  /** Best-guess placement + the specific legality flaw, when no orientation
   *  produced a legal read. */
  candidate_placement?: string | null;
  candidate_flaw?: string | null;
};

export type BoardVisionConfig = {
  baseUrl: string;
  apiKey: string;
};

const ENDPOINT_PATH = '/api/v1/external/chess/board-position';

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function readBoardPosition(
  config: BoardVisionConfig,
  frame: Blob,
  orientation?: BoardOrientation,
): Promise<BoardPositionResult> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}${ENDPOINT_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_base64: await toBase64(frame),
      ...(orientation !== undefined ? { orientation } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`board-position endpoint returned ${res.status}`);
  }
  return (await res.json()) as BoardPositionResult;
}
