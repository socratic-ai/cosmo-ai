import type { ClientToolSpec } from 'cosmo-ai';
// The factories come from the leaf entry, not the barrel: the barrel pulls in
// livekit-client, which nothing at module-evaluation time needs.
import {
  drawBox,
  drawPoint,
  notShown,
  shown,
  type DrawBoxRequest,
  type DrawOutcome,
  type DrawPointRequest,
} from 'cosmo-ai/tool/draw';

// The renderers the SDK ships (``cosmo_sdk_draw_box`` / ``cosmo_sdk_draw_point``)
// rather than an app-specific pair: the locators that feed them name them in
// their own descriptions, so a surface that declares different names is told
// to call a tool it doesn't have and draws nothing.
//
// The specs are built once, at module scope, because the session starts above
// the component that owns the camera view; the view registers itself here
// while it is mounted, and until it does the model is told — in words it can
// say — that there is nothing to draw on.
type DrawSurface = {
  showBox: (request: DrawBoxRequest) => void;
  showPoint: (request: DrawPointRequest) => void;
};

let surface: DrawSurface | null = null;

export function setDrawSurface(next: DrawSurface | null): void {
  surface = next;
}

function draw(render: (surface: DrawSurface) => void): DrawOutcome {
  if (surface === null) {
    return notShown('the camera view is closed — ask the user to point the camera first');
  }
  render(surface);
  return shown;
}

export const DRAW_TOOLS: ClientToolSpec[] = [
  drawBox((request) => draw((s) => s.showBox(request))),
  drawPoint((request) => draw((s) => s.showPoint(request))),
];
