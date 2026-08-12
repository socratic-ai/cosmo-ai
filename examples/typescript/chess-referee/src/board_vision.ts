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

const ENDPOINT_PATH = '/api/v1/chess/board-position';

export async function readBoardPosition(
  config: BoardVisionConfig,
  frame: Blob,
  orientation?: BoardOrientation,
): Promise<BoardPositionResult> {
  const form = new FormData();
  form.append('image', frame, 'board.jpg');
  if (orientation !== undefined) form.append('orientation', orientation);
  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}${ENDPOINT_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`board-position endpoint returned ${res.status}`);
  }
  return (await res.json()) as BoardPositionResult;
}
