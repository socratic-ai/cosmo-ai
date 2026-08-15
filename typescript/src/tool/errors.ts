/**
 * Typed errors for the tool builder, plus the normalized ``INVALID_INPUT``
 * message shape shared across the SDKs.
 */

/** One sanitized validation issue: structured path + constraint text built
 *  from schema-derived fields only — the submitted values never appear. */
export type ToolInputIssue = {
  /** Property path segments from the args root (numbers are array indices). */
  path: (string | number)[];
  /** The validator's stable issue code (e.g. ``'invalid_type'``). */
  code: string;
  /** Human-readable constraint (``'required'``, ``'expected a string'``). */
  constraint: string;
};

/** A tool's JSON Schema cannot be expressed in the restricted dialect the
 *  realtime backend accepts. Thrown when the tool is constructed (typically
 *  import/startup), not at session connect. ``code`` is a stable slug shared
 *  with the cross-SDK conformance vectors (e.g. ``'forbidden_key'``,
 *  ``'max_depth_exceeded'``). */
export class ToolSchemaError extends Error {
  readonly code: string;

  constructor(opts: { code: string; message: string }) {
    super(opts.message !== '' ? `${opts.code}: ${opts.message}` : opts.code);
    this.name = 'ToolSchemaError';
    this.code = opts.code;
  }
}

/** The model's arguments failed validation inside a builder-synthesized
 *  tool handler. The message follows the normalized ``INVALID_INPUT`` shape
 *  and is built from structured issue fields only — submitted values never
 *  appear. ``issues`` carries the same sanitized issues structurally. */
export class ToolInputValidationError extends Error {
  readonly issues: ToolInputIssue[];

  constructor(message: string, opts: { issues: ToolInputIssue[] }) {
    super(message);
    this.name = 'ToolInputValidationError';
    this.issues = opts.issues;
  }
}

const MAX_ISSUE_LINES = 5;
const MAX_MESSAGE_BYTES = 1024;

function issuePath(path: (string | number)[]): string {
  const parts: string[] = [];
  for (const item of path) {
    if (typeof item === 'number') parts.push(`[${item}]`);
    else if (parts.length > 0) parts.push(`.${item}`);
    else parts.push(String(item));
  }
  return parts.join('') || '(root)';
}

/** Build the normalized ``INVALID_INPUT`` message: at most
 *  {@link MAX_ISSUE_LINES} issue lines (then ``… and N more``), shrunk until
 *  the whole message fits {@link MAX_MESSAGE_BYTES}. */
export function formatInvalidInput(toolName: string, issues: ToolInputIssue[]): string {
  const header = `INVALID_INPUT: ${toolName} rejected parameters:`;
  const footer = 'Fix the input and retry.';
  let shown = Math.min(issues.length, MAX_ISSUE_LINES);
  for (;;) {
    const lines = issues
      .slice(0, shown)
      .map((issue) => `- ${issuePath(issue.path)}: ${issue.constraint}`);
    const hidden = issues.length - shown;
    if (hidden > 0) lines.push(`- … and ${hidden} more`);
    const message = [header, ...lines, footer].join('\n');
    if (new TextEncoder().encode(message).length <= MAX_MESSAGE_BYTES || shown === 0) {
      return message;
    }
    shown -= 1;
  }
}
