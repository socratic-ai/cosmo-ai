/**
 * The renderer client tools the SDK ships: ``cosmo_sdk_draw_box`` and
 * ``cosmo_sdk_draw_point``.
 *
 * A server-side locator (``{ kind: 'detect_objects' }`` /
 * ``{ kind: 'point_at_object' }``) hands the model candidate boxes or points;
 * the model picks the one that matches what it is looking at and passes it
 * here for the app to draw over the user's live view::
 *
 *     const agent = client.agent({
 *       instructions: 'help the user find things on screen',
 *       tools: [
 *         { kind: 'detect_objects' },
 *         drawBox((request) => {
 *           if (!preview.visible) return notShown('the preview is not on screen');
 *           preview.showBox(request);
 *           return shown;
 *         }),
 *       ],
 *     });
 *
 * The SDK owns the name, description, schema, decode and reply shape; the
 * caller supplies one function of request → outcome, closing over whatever
 * app state it draws with. Coordinates, wording, and the reply shape are
 * cross-SDK contract, pinned by ``sdk-client-tool-vectors.json``.
 */

import type { ClientToolSpec } from '../core/agent';

import { markSdkClientTool } from './sdk_tool';

/** Where to draw, normalized to the frame the model was shown: ``[0,1]``,
 *  top-left origin (y increases downward). */
export type NormalizedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Where to mark, in the same normalized space. */
export type NormalizedPoint = {
  x: number;
  y: number;
};

/** One model request to draw a box over the user's live view. */
export type DrawBoxRequest = {
  box: NormalizedBox;
  label?: string;
};

/** One model request to mark a single spot over the user's live view. */
export type DrawPointRequest = {
  point: NormalizedPoint;
  label?: string;
};

/** What a renderer reports back to the model.
 *
 *  Drawing can fail for reasons the model has to hear about — the camera is
 *  off, the preview isn't on screen. Answering "shown" regardless would leave
 *  it talking about something the user cannot see, so a refusal carries a
 *  reason the agent can say out loud. */
export type DrawOutcome = { shown: true } | { shown: false; reason: string };

/** The refusal arm every renderer shares — the camera draws and the screen
 *  highlights alike, since "nothing was drawn, and here is why" carries no
 *  detail either of them needs to qualify. Named so {@link notShown} can serve
 *  both without either outcome type importing the other. */
export type NotShown = { shown: false; reason: string };

/** The annotation is on screen. */
export const shown: DrawOutcome = { shown: true };

/** Nothing was drawn. ``reason`` is model-facing: write it as an instruction
 *  the agent can speak ("the camera is off — ask the user to turn it on"),
 *  not as an error code. */
export function notShown(reason: string): NotShown {
  return { shown: false, reason };
}

/** Wire name shipped in tool-call events; a rename is a wire break. */
export const DRAW_BOX_TOOL_NAME = 'cosmo_sdk_draw_box';
export const DRAW_POINT_TOOL_NAME = 'cosmo_sdk_draw_point';

const DRAW_BOX_DESCRIPTION =
  "Draw a box over the user's live view (their camera or screen preview) around " +
  'something cosmo_detect_objects located — pass a box it returned, normalized to ' +
  'the frame you were shown ([0,1], top-left origin), and an optional short label. ' +
  'Call this after cosmo_detect_objects rather than guessing a box yourself. ' +
  'Visual only — it measures nothing and changes nothing.';

const DRAW_POINT_DESCRIPTION =
  "Mark a single spot on the user's live view (their camera or screen preview) — one " +
  'leaf, one screw, one control — using a point cosmo_point_at_object returned, ' +
  'normalized to the frame you were shown ([0,1], top-left origin), with an optional ' +
  'short label. Call this after cosmo_point_at_object rather than guessing a position ' +
  'yourself. Visual only — it measures nothing and changes nothing.';

const DRAW_BOX_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    box: {
      type: 'object',
      description:
        'Where to draw, normalized to the frame you were shown: [0,1], top-left origin.',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        width: { type: 'number', minimum: 0, maximum: 1 },
        height: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    label: {
      type: 'string',
      maxLength: 40,
      description: "Short caption shown on the box, e.g. 'blush here'.",
    },
  },
  required: ['box'],
};

const DRAW_POINT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    point: {
      type: 'object',
      description:
        'Where to point, normalized to the frame you were shown: [0,1], top-left origin.',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['x', 'y'],
    },
    label: {
      type: 'string',
      maxLength: 40,
      description: "Short caption shown beside the marker, e.g. 'this screw'.",
    },
  },
  required: ['point'],
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function coordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp01(value)
    : null;
}

function label(args: Record<string, unknown>): string | undefined {
  return typeof args.label === 'string' ? args.label : undefined;
}

/** Decode a ``cosmo_sdk_draw_box`` invocation. ``null`` when the box is
 *  absent or malformed — a boundary check on model output, not an invariant.
 *  Coordinates are clamped, so a model that overshoots the frame edge still
 *  yields a drawable box. */
export function parseDrawBoxRequest(
  args: Record<string, unknown>,
): DrawBoxRequest | null {
  const raw = args.box;
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const x = coordinate(candidate.x);
  const y = coordinate(candidate.y);
  const width = coordinate(candidate.width);
  const height = coordinate(candidate.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { box: { x, y, width, height }, label: label(args) };
}

/** Decode a ``cosmo_sdk_draw_point`` invocation. Same contract as
 *  {@link parseDrawBoxRequest}. */
export function parseDrawPointRequest(
  args: Record<string, unknown>,
): DrawPointRequest | null {
  const raw = args.point;
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const x = coordinate(candidate.x);
  const y = coordinate(candidate.y);
  if (x === null || y === null) return null;
  return { point: { x, y }, label: label(args) };
}

/** The box renderer, ready to add to an agent's ``tools`` alongside the
 *  locator that feeds it. Your handler owns only the drawing — and the honest
 *  answer about whether it happened. Malformed arguments surface to the model
 *  as the call's error without reaching your code. */
export function drawBox(
  onDraw: (request: DrawBoxRequest) => DrawOutcome | Promise<DrawOutcome>,
): ClientToolSpec {
  return markSdkClientTool({
    kind: 'client',
    name: DRAW_BOX_TOOL_NAME,
    description: DRAW_BOX_DESCRIPTION,
    parameters: DRAW_BOX_PARAMETERS,
    handler: async (args) => {
      const request = parseDrawBoxRequest(args);
      if (request === null) {
        throw new Error(
          `${DRAW_BOX_TOOL_NAME}: pass box {x,y,width,height} normalized to [0,1]`,
        );
      }
      return { ...(await onDraw(request)) };
    },
  });
}

/** The point renderer. Same contract as {@link drawBox}, with a
 *  {@link DrawPointRequest}. */
export function drawPoint(
  onDraw: (request: DrawPointRequest) => DrawOutcome | Promise<DrawOutcome>,
): ClientToolSpec {
  return markSdkClientTool({
    kind: 'client',
    name: DRAW_POINT_TOOL_NAME,
    description: DRAW_POINT_DESCRIPTION,
    parameters: DRAW_POINT_PARAMETERS,
    handler: async (args) => {
      const request = parseDrawPointRequest(args);
      if (request === null) {
        throw new Error(
          `${DRAW_POINT_TOOL_NAME}: pass point {x,y} normalized to [0,1]`,
        );
      }
      return { ...(await onDraw(request)) };
    },
  });
}
