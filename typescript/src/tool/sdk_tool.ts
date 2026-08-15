import type { ClientToolSpec } from '../core/agent';

/** Marks a spec as one the SDK built itself.
 *
 *  The ``cosmo_sdk_`` prefix is reserved, and the check that enforces it has
 *  to let the SDK's own tools through. Recognizing them by name would leave
 *  the dangerous case open — a hand-built spec taking an SDK tool's *exact*
 *  name, replacing its schema and handler with something the model was told
 *  behaves differently. So the exemption is carried by an unexported symbol
 *  a factory attaches instead: nothing outside this package can put it on an
 *  object. It is non-enumerable, so it never reaches the wire. */
const SDK_CLIENT_TOOL = Symbol('cosmo.sdk.clientTool');

export function markSdkClientTool(spec: ClientToolSpec): ClientToolSpec {
  return Object.defineProperty(spec, SDK_CLIENT_TOOL, {
    value: true,
    enumerable: false,
  });
}

export function isSdkClientTool(spec: object): boolean {
  return (spec as Record<symbol, unknown>)[SDK_CLIENT_TOOL] === true;
}
