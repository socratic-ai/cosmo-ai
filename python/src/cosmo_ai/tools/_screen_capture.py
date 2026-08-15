"""The wire and capture plumbing behind the locator: the tool-name and RPC
constants that pin the contract, the cache that pairs a capture with the handles
minted from it, the ``found_element`` handle codec, and the ``screen_capture``
RPC body the server-side locator drives. This is the SDK's side of a two-party
contract with the backend, so the constants, the handle shape, and the payload
encoding are pinned by ``sdk-client-tool-vectors.json`` and matched to
the sibling SDKs.
"""

from __future__ import annotations

import base64
import inspect
import json
import re
import time
from collections.abc import Sequence
from typing import Any, Awaitable, Callable

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.protocol import ClientToolHandler, ScreenLocateTool
from cosmo_ai._internal.transport import Transport
from cosmo_ai.tools._dispatch import make_rpc_handler
from cosmo_ai.tools._screen_types import (
    FoundElement,
    ScreenCapture,
    ScreenCaptureRequest,
    _resolved,
)

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

SCREEN_CLICK_TOOL_NAME = "cosmo_sdk_screen_click_element"
"""Wire name shipped in ``tool-invocation`` events; a rename is a wire break."""

SCREEN_HIGHLIGHT_TOOL_NAME = "cosmo_sdk_screen_highlight_element"
"""Wire name shipped in ``tool-invocation`` events; a rename is a wire break."""

SCREEN_HIGHLIGHT_BOX_TOOL_NAME = "cosmo_sdk_screen_highlight_box"
"""Wire name shipped in ``tool-invocation`` events; a rename is a wire break."""

_FOUND_ELEMENT_SEPARATOR = "#"
"""Joins the two halves inside a ``found_element`` handle; must match the
backend's ``encode_found_element`` and the sibling SDKs. Pinned by
``sdk-client-tool-vectors.json`` (``foundElement``)."""

_HANDLE_PATTERN = re.compile(r"^(.+)#(\d+)$")
"""Splits a handle into the capture it names and the element's index there. The
rightmost separator binds (``.+`` is greedy), so a capture id containing one
survives the round trip."""

SCREEN_CAPTURE_RPC_METHOD = "screen_capture"
"""RPC method the locator's capture step drives; matches the backend's
``SCREEN_CAPTURE_RPC`` and the sibling SDKs."""

_SCREEN_CAPTURE_TOPIC = "screen_capture"
"""Byte-stream topic the capture payload rides; matches the backend's
``SCREEN_CAPTURE_TOPIC``."""


# ─────────────────────────────────────────────────────────────────────────────
# Capture cache
# ─────────────────────────────────────────────────────────────────────────────


class ScreenCaptureCache:
    """Pairs a capture with the refs minted from it, keyed by ``capture_id``.
    Entries expire (``ttl_seconds``) and the count is bounded (``max_entries``).
    Capture ids are server-minted per call, so an entry is only ever read back by
    the ref it was created for."""

    def __init__(
        self,
        ttl_seconds: float = 30.0,
        max_entries: int = 4,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._now = now
        self._entries: dict[str, tuple[float, ScreenCapture]] = {}

    def put(self, capture_id: str, capture: ScreenCapture) -> None:
        moment = self._now()
        self._entries[capture_id] = (moment, capture)
        for cid in list(self._entries):
            at, _capture = self._entries[cid]
            if moment - at >= self._ttl:
                del self._entries[cid]
        # dict preserves insertion order, so the oldest live entry is first.
        while len(self._entries) > self._max:
            del self._entries[next(iter(self._entries))]

    def get(self, capture_id: str) -> ScreenCapture | None:
        entry = self._entries.get(capture_id)
        if entry is None:
            return None
        at, capture = entry
        if self._now() - at >= self._ttl:
            return None
        return capture


# The captures handles currently address. Module-scoped because the renderers
# are built independently — the capture handler fills it and the renderers read
# it, with no object in between for the caller to thread.
_capture_cache = ScreenCaptureCache()

# Model-facing: a handle the cache can no longer resolve is a benign decline, not
# an error — the model's move is to locate again, not to retry.
_UNRESOLVABLE_HANDLE_REASON = (
    "that found_element is no longer valid — call cosmo_screen_locate again for a "
    "fresh one"
)


def encode_found_element(capture_id: str, element_idx: int) -> str:
    """Mint a handle the way the backend's ``encode_found_element`` does. The SDK
    never calls this in production — the locator is the only minter — but the
    format is a two-party contract with the backend, so it is written down in
    code both sides' vectors can be checked against."""
    return f"{capture_id}{_FOUND_ELEMENT_SEPARATOR}{element_idx}"


def parse_found_element_handle(handle: str) -> FoundElement | None:
    """Split a handle into the capture it names and the element's index there;
    ``None`` when it is not one this SDK minted the shape of."""
    match = _HANDLE_PATTERN.match(handle)
    if match is None:
        return None
    return FoundElement(capture_id=match.group(1), element_idx=int(match.group(2)))


# ─────────────────────────────────────────────────────────────────────────────
# Capture handoff — the screen_capture RPC the locator drives
# ─────────────────────────────────────────────────────────────────────────────


# AX descriptor budgets, matching the backend's ``AXElement``. A descriptor is a
# *name* for a click target, so anything longer is a document the screenshot
# already shows; ``value`` is content rather than identity and is held tighter.
# The backend clamps too — capping here keeps the bytes off the wire rather than
# guarding validation.
_ROLE_MAX_CHARS = 64
_LABEL_MAX_CHARS = 512
_VALUE_MAX_CHARS = 256


def _screen_capture_payload(
    capture_id: str,
    capture: ScreenCapture,
    mime_type: str = "image/jpeg",
    *,
    include_elements: bool = True,
) -> bytes:
    """Encode a capture into the ``ScreenCapturePayload`` JSON bytes the byte
    stream carries. Absent descriptors are omitted. The list still rides as
    ``ax_elements``; the server also accepts ``elements``, and this SDK moves
    once every deployed backend reads both."""
    ax_elements: list[dict[str, Any]] = []
    for element in capture.elements if include_elements else ():
        obj: dict[str, Any] = {
            "idx": element.index,
            "role": element.role[:_ROLE_MAX_CHARS],
            "frame": list(element.frame),
        }
        if element.title is not None:
            obj["title"] = element.title[:_LABEL_MAX_CHARS]
        if element.label is not None:
            obj["label"] = element.label[:_LABEL_MAX_CHARS]
        # Carried only where it is the element's sole name: the grounder reads
        # the screenshot, so a named element's content is a second copy of
        # pixels it can already see. A blank descriptor names nothing.
        named = (
            str(obj.get("title") or "").strip() or str(obj.get("label") or "").strip()
        )
        if element.value is not None and not named:
            obj["value"] = element.value[:_VALUE_MAX_CHARS]
        ax_elements.append(obj)
    payload = {
        "capture_id": capture_id,
        "image_b64": base64.b64encode(capture.image_jpeg).decode("ascii"),
        "mime_type": mime_type,
        "ax_elements": ax_elements,
    }
    return json.dumps(payload).encode("utf-8")


def _capture_takes_request(capture: Callable[..., Any]) -> bool:
    """Whether a capture handler wants the :class:`ScreenCaptureRequest`. Both
    forms are supported, so a host that does not care about the hint keeps its
    existing no-argument handler. A callable that cannot be introspected (a
    builtin, some C extensions) is called the original way."""
    try:
        return bool(inspect.signature(capture).parameters)
    except (TypeError, ValueError):
        logger.warning(
            "realtime.capture_signature_unreadable",
            capture=getattr(capture, "__qualname__", repr(capture)),
            exc_info=True,
        )
        return False


def screen_capture_handler(
    spec: ScreenLocateTool,
    send_bytes: Callable[[bytes, str], Awaitable[None]],
    *,
    cache: ScreenCaptureCache = _capture_cache,
) -> ClientToolHandler:
    """The ``screen_capture`` RPC body: take the snapshot, keep it for the refs
    the locator is about to mint, publish it, and ack. A handler that raises is
    answered as "no capture" rather than as an RPC error — the locator has its
    own typed answer for it — while a byte-stream publish failure propagates and
    reaches the model as the call's error."""
    takes_request = _capture_takes_request(spec.capture)

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        capture_id = args.get("capture_id")
        if not isinstance(capture_id, str) or not capture_id:
            return {"captured": False}
        # Absent means a server older than the hint, which only ever wanted both.
        wants_elements = args.get("want_elements", True) is not False
        try:
            request = ScreenCaptureRequest(wants_elements)
            capture = await _resolved(
                spec.capture(request) if takes_request else spec.capture()
            )
        except Exception as exc:
            logger.exception("realtime.screen_capture_failed", stack_info=True)
            # The message is what the locator says to the model when it cannot
            # see the screen, so a handler that explains itself ("the user
            # stopped sharing") reaches them rather than the generic fallback.
            return {"captured": False, "message": str(exc) or exc.__class__.__name__}
        cache.put(capture_id, capture)
        await send_bytes(
            _screen_capture_payload(
                capture_id, capture, include_elements=wants_elements
            ),
            _SCREEN_CAPTURE_TOPIC,
        )
        return {"captured": True}

    return handler


def register_screen_locate(
    transport: Transport,
    tools: Sequence[Any],
    *,
    cache: ScreenCaptureCache = _capture_cache,
) -> None:
    """Register the locator's capture RPC when the tool set declares one
    (register-without-advertise: the tool list declares the locator, never this
    method). No-op when no :class:`ScreenLocateTool` is present."""
    spec = next((tool for tool in tools if isinstance(tool, ScreenLocateTool)), None)
    if spec is None:
        return
    handler = screen_capture_handler(spec, transport.send_bytes, cache=cache)
    transport.register_rpc_method(
        SCREEN_CAPTURE_RPC_METHOD,
        make_rpc_handler(SCREEN_CAPTURE_RPC_METHOD, handler),
    )
    logger.info("realtime.screen_capture_registered")
