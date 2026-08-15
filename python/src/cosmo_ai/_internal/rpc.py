"""Shared RPC-method plumbing for the transport's RPC surface (client tools):
the agent-only caller guard, request decode, and the ``{ok, result, error}``
reply envelope with its size cap. The client-tool dispatch layer builds its
handler variants on top of these primitives."""

from __future__ import annotations

import json
from typing import Any

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.transport import RpcInvocation, RpcMethodError

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

# Cap the serialized reply so a runaway handler result cannot exceed the
# transport's payload ceiling. Error text, ack notes, and success results are
# all shortened to fit rather than dropped. Pinned against
# ``sdk-client-tool-vectors.json`` so the three SDKs cannot drift.
MAX_REPLY_BYTES = 15 * 1024
TRUNCATION_SUFFIX = "… [truncated]"
TRUNCATION_MARKER_KEY = "cosmo_sdk_truncated"
TRUNCATION_MARKER_NOTE = (
    "partial result — do not answer as if it were complete; "
    "narrow the request or say what is missing."
)


def dumps(value: Any) -> str:
    """Serialize ``value`` the way the other two SDKs do: compact, and UTF-8
    rather than ASCII escapes. ``json.dumps`` defaults disagree with both —
    non-ASCII would cost six bytes a character against the cap, so the same
    result would ship whole from one SDK and shortened from another. Pinned by
    ``replyLimits.envelope``."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def reply_envelope(
    *,
    ok: bool,
    result: dict[str, Any] | None,
    error: str | None,
    deferred: bool = False,
    job_id: str | None = None,
) -> str:
    envelope: dict[str, Any] = {"ok": ok, "result": result, "error": error}
    # Only a deferred ack carries these keys, so a normal reply is byte-unchanged.
    if deferred:
        envelope["deferred"] = True
        envelope["job_id"] = job_id
    return dumps(envelope)


def oversized(envelope: str) -> bool:
    return len(envelope.encode("utf-8")) > MAX_REPLY_BYTES


def error_reply(message: str) -> str:
    """A ``{ok: false}`` envelope whose serialized form fits the size cap,
    truncating the error text if needed."""
    envelope = reply_envelope(ok=False, result=None, error=message)
    if not oversized(envelope):
        return envelope
    # JSON-escaping and the multi-byte suffix make the encoded size hard to
    # predict from the message length, so shrink the kept prefix until the
    # full envelope fits.
    keep = len(message)
    while keep > 0:
        truncated = message[:keep] + TRUNCATION_SUFFIX
        envelope = reply_envelope(ok=False, result=None, error=truncated)
        if not oversized(envelope):
            return envelope
        overshoot = len(envelope.encode("utf-8")) - MAX_REPLY_BYTES
        keep -= max(overshoot, 1)
    return reply_envelope(ok=False, result=None, error=TRUNCATION_SUFFIX)


def deferred_reply(*, job_id: str, note: str) -> str:
    """The deferred-ack envelope, shrinking ``note`` if needed so the reply
    fits the size cap."""

    def build(text: str) -> str:
        return reply_envelope(
            ok=True,
            result={"note": text} if text else {},
            error=None,
            deferred=True,
            job_id=job_id,
        )

    envelope = build(note)
    if not oversized(envelope):
        return envelope
    logger.warning("realtime.client_tool_ack_note_truncated", job_id=job_id)
    keep = len(note)
    while keep > 0:
        envelope = build(note[:keep] + TRUNCATION_SUFFIX)
        if not oversized(envelope):
            return envelope
        keep -= max(len(envelope.encode("utf-8")) - MAX_REPLY_BYTES, 1)
    return build(TRUNCATION_SUFFIX)


def _shrink_one(text: str, max_scalars: int) -> str:
    if len(text) <= max_scalars:
        return text
    shortened = text[:max_scalars] + TRUNCATION_SUFFIX
    # Never spend more bytes than the string being replaced: the suffix is
    # longer than what it stands in for on a short string. Keeping the whole
    # string there is both smaller and truthful, and it is what makes the
    # shortened size rise monotonically with the allowance — the property
    # ``success_reply``'s binary search needs to be able to prune.
    if len(shortened.encode("utf-8")) >= len(text.encode("utf-8")):
        return text
    return shortened


def shrink_strings(value: Any, max_scalars: int) -> Any:
    """Shorten every string in ``value`` to at most ``max_scalars`` Unicode
    scalars, leaving any string the suffix would not actually shrink. Applied
    to the original each time, so a second pass never truncates a suffix the
    first wrote. Scalars — what ``str`` indexes by — are the one unit all three
    SDKs count identically. Pinned by ``replyLimits.shrink``."""
    if isinstance(value, str):
        return _shrink_one(value, max_scalars)
    if isinstance(value, list):
        return [shrink_strings(item, max_scalars) for item in value]
    if isinstance(value, dict):
        return {key: shrink_strings(item, max_scalars) for key, item in value.items()}
    return value


def _longest_string_length(value: Any) -> int:
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return max((_longest_string_length(item) for item in value), default=0)
    if isinstance(value, dict):
        return max((_longest_string_length(item) for item in value.values()), default=0)
    return 0


def _serialized_bytes(value: Any) -> int:
    return len(dumps(value).encode("utf-8"))


def _entry_bytes(key: str, value: Any) -> int:
    """What one top-level entry costs the envelope — its key as well as its
    value, since a long key spends the same bytes a long value does."""
    return _serialized_bytes({key: value})


def _marked_envelope(result: dict[str, Any], original_bytes: int) -> str:
    """``result`` plus the truncation marker: the note, and how much of
    ``original_bytes`` survived."""
    return reply_envelope(
        ok=True,
        result={
            **result,
            TRUNCATION_MARKER_KEY: {
                "note": TRUNCATION_MARKER_NOTE,
                "kept_bytes": _serialized_bytes(result),
                "original_bytes": original_bytes,
            },
        },
        error=None,
    )


def success_reply(result: dict[str, Any] | None) -> tuple[str, bool]:
    """An ``{ok: true}`` envelope whose serialized form fits the size cap,
    paired with whether it had to be shortened to get there.

    An over-budget result is shortened structurally rather than by cutting the
    serialized envelope, so the reply the model reads is always well-formed
    JSON: strings shrink to the largest common allowance that fits, and if the
    non-string structure alone still overflows, top-level entries are dropped
    largest-first. Either way the result carries ``TRUNCATION_MARKER_KEY`` so
    the model knows to ask a narrower question instead of reading the reply as
    the whole answer."""
    envelope = reply_envelope(ok=True, result=result, error=None)
    if result is None or not oversized(envelope):
        return envelope, False
    original_bytes = _serialized_bytes(result)

    # Largest per-string allowance that fits. JSON escaping makes encoded size
    # unpredictable from character counts, so search rather than compute it.
    low, high = 0, _longest_string_length(result)
    best: str | None = None
    while low <= high:
        mid = low + (high - low) // 2
        candidate = _marked_envelope(shrink_strings(result, mid), original_bytes)
        if oversized(candidate):
            high = mid - 1
        else:
            best = candidate
            low = mid + 1
    if best is not None:
        return best, True

    # Non-string structure (long lists, many keys) is what overflows: drop
    # top-level entries, biggest first, until what remains fits. Each entry is
    # sized once, and how many to drop is found by binary search — dropping more
    # only ever shrinks the reply, so the fit is monotone in the count.
    fields: dict[str, Any] = shrink_strings(result, 0)
    widest_first = sorted(fields, key=lambda key: (_entry_bytes(key, fields[key]), key), reverse=True)

    def after_dropping(count: int) -> str:
        dropped = set(widest_first[:count])
        return _marked_envelope(
            {key: value for key, value in fields.items() if key not in dropped},
            original_bytes,
        )

    low, high, fitted = 1, len(widest_first), None
    while low <= high:
        mid = low + (high - low) // 2
        candidate = after_dropping(mid)
        if oversized(candidate):
            low = mid + 1
        else:
            fitted = candidate
            high = mid - 1
    return (fitted if fitted is not None else _marked_envelope({}, original_bytes)), True


def decode_args(payload: str) -> dict[str, Any] | str:
    """Decode the RPC request payload into an args dict, or return an error
    message string for a malformed payload."""
    try:
        args = json.loads(payload) if payload else {}
    except (json.JSONDecodeError, ValueError):
        logger.warning("realtime.rpc_args_not_json")
        return "client tool args were not valid JSON"
    if not isinstance(args, dict):
        return "client tool args must be a JSON object"
    return args


def ensure_agent_caller(invocation: RpcInvocation, *, method_name: str) -> None:
    """Reject any caller the transport did not resolve to the session agent."""
    if not invocation.caller_is_agent:
        logger.warning(
            "realtime.client_tool_caller_rejected",
            method=method_name,
            caller_identity=invocation.caller_identity,
        )
        raise RpcMethodError(
            code=1500,
            message="client tools may only be invoked by the session agent",
        )
