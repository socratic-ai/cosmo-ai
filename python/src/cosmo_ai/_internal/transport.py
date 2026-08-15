"""Protocol-agnostic transport under :class:`~cosmo_ai.session.RealtimeSession`.

The session depends on :class:`Transport` rather than a concrete adapter, so all
LiveKit access is quarantined behind one boundary (``session/_livekit.py`` in
production; a ``FakeTransport`` in the test suite). The wire shape is still the
typed ``Realtime*`` protocol models the session serializes; only the delivery
mechanism varies. No vendor (``rtc.*``) types appear in these signatures —
media handles cross as opaque objects the caller already owns.

Mirrors the sibling SDKs' transport seams: Swift's ``SessionTransport`` /
``LiveKitSessionTransport`` and TypeScript's ``RealtimeTransport`` /
``LiveKitTransport``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional, Protocol

from cosmo_ai._internal.protocol import SessionResponse
from cosmo_ai.audio import AgentAudioFrame


@dataclass(frozen=True)
class RpcInvocation:
    """One inbound client-tool RPC invocation, narrowed at the transport
    boundary so client-tool dispatch never imports vendor types.

    ``payload`` is the JSON-encoded args object; ``caller_identity`` is the
    invoking participant's room identity; ``caller_is_agent`` is ``True`` when
    that participant is the session's agent — the transport resolves the vendor
    participant-kind, and client-tool dispatch uses this as the agent-only
    caller guard."""

    payload: str
    caller_identity: str
    caller_is_agent: bool


class RpcMethodError(Exception):
    """Vendor-free failure raised by an RPC handler to reject an invocation
    (e.g. the caller guard). The adapter maps it onto the transport's native
    error so the agent sees a real RPC failure rather than a handler result."""

    def __init__(self, *, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


RpcHandler = Callable[[RpcInvocation], Awaitable[str]]
"""An inbound RPC method: given a vendor-free :class:`RpcInvocation`, returns
the JSON-encoded ``{ok, result, error}`` reply envelope."""


class AgentAudioSink(Protocol):
    """Where a transport lands the agent's decoded audio. ``deliver`` is
    called on the event loop once per frame."""

    def deliver(self, frame: AgentAudioFrame) -> None: ...


@dataclass(frozen=True)
class TransportClose:
    """Unsolicited transport teardown, pre-classified by the adapter.

    ``kind`` is ``"server_ended"`` for a deliberate server-side close (room
    deleted / closed, participant removed) and ``"transport_error"`` for
    everything else; ``detail`` carries the transport's reason name when
    known."""

    kind: Literal["server_ended", "transport_error"]
    detail: Optional[str]


@dataclass(frozen=True)
class TransportCallbacks:
    """How a transport reports asynchronous activity back to the session.

    ``on_frame`` delivers one inbound data-channel packet (already unwrapped to
    bytes). ``on_closed`` fires for an unsolicited transport teardown with the
    pre-classified :class:`TransportClose`. ``on_reconnecting`` /
    ``on_reconnected`` bracket a transient transport recovery the underlying
    stack handles itself. All four are synchronous; a callback that needs to do
    async work schedules it (the session spawns a task)."""

    on_frame: Callable[[bytes], None]
    on_closed: Callable[[TransportClose], None]
    on_reconnecting: Callable[[], None]
    on_reconnected: Callable[[], None]


class Transport(Protocol):
    """Carries opaque JSON frames both ways and owns the media path. Production
    is ``LiveKitTransport``; tests inject a ``FakeTransport``."""

    async def connect(
        self,
        response: SessionResponse,
        callbacks: TransportCallbacks,
    ) -> None:
        """Bring up the media transport against the join credentials in
        ``response`` and wire ``callbacks`` for inbound frames and lifecycle.
        Returns once the transport is live; server frames then flow through
        ``callbacks.on_frame``. Raises on join failure."""
        ...

    def is_connected(self) -> bool:
        """True while the media transport is live."""
        ...

    async def disconnect(self) -> None:
        """Tear down the media transport, releasing any published mic /
        screen-share tracks. Idempotent."""
        ...

    async def send_frame(self, payload: bytes) -> None:
        """Publish one serialized wire frame to the room's reliable data
        channel. Raises :class:`~cosmo_ai.errors.NotConnectedError` when
        the transport is not connected."""
        ...

    async def send_bytes(self, data: bytes, topic: str) -> None:
        """Publish one opaque binary payload to the agent participant(s) over a
        byte stream on ``topic``, never the reliable data channel and never
        broadcast to the room. The transport opens a stream targeted at the
        agent identities, writes ``data`` whole, and closes it.

        Distinct from :meth:`send_frame`: that carries the JSON protocol frames
        the session speaks, on the shared data channel; this carries an
        out-of-band binary payload (a screen capture) large enough to warrant a
        stream and private enough to warrant explicit destinations. Raises
        :class:`~cosmo_ai.errors.NotConnectedError` when the transport is not
        connected or no agent is present to receive it. Mirrors the sibling
        SDKs' ``sendBytes``."""
        ...

    def register_rpc_method(self, name: str, handler: RpcHandler) -> None:
        """Register an inbound RPC method the agent can invoke for client-tool
        execution. Callable before :meth:`connect`: the adapter must guarantee
        every method registered pre-connect is live before it delivers any
        inbound invocation, so a call arriving during the join is handled
        rather than rejected as unknown. The adapter wraps ``handler`` so it
        receives a vendor-free :class:`RpcInvocation` and its
        :class:`RpcMethodError` maps onto the transport's native RPC error."""
        ...

    async def publish_audio_source(
        self, source: Any, *, track_name: str = "mic"
    ) -> Any:
        """Publish ``source`` (an opaque, caller-owned audio source) as the mic
        track and return an opaque publication handle for
        :meth:`unpublish_track`. Raises
        :class:`~cosmo_ai.errors.NotConnectedError` when not connected."""
        ...

    async def unpublish_track(self, publication: Any) -> None:
        """Unpublish a track previously returned by :meth:`publish_audio_source`
        (or a screen-share publish). Best-effort; a torn-down transport is a
        no-op."""
        ...

    def set_agent_audio_sink(self, sink: "AgentAudioSink | None") -> None:
        """Attach (or detach, with ``None``) the destination for the agent's
        decoded audio. While a sink is attached the transport decodes the
        agent's audio track and delivers each frame; detaching releases the
        decode pipeline. Frames start flowing once the agent's audio track is
        available, including a track that appears later. Idempotent."""
        ...

    async def start_screen_share(self, *, width: int, height: int) -> None:
        """Create the screen-share track; the publish is deferred to the first
        :meth:`push_screen_share_frame` so dimensions resolve from the source.
        Idempotent (restarts an active share)."""
        ...

    def push_screen_share_frame(self, frame: Any) -> None:
        """Push one captured frame (opaque, caller-owned) into the active
        share, triggering the deferred publish on the first frame. No-op when no
        share is active."""
        ...

    async def stop_screen_share(self) -> None:
        """Unpublish the active screen-share track. Idempotent."""
        ...

    async def add_video_stream(self, *, width: int, height: int) -> str:
        """Create a non-screen video track (a camera, a file, any pixels-only
        source) and return its stream id. Same deferred-publish contract as
        :meth:`start_screen_share`. Raises
        :class:`~cosmo_ai.errors.VideoPublishAlreadyActiveError` while any
        video publish — stream or share — is live."""
        ...

    def push_video_frame(self, stream_id: str, frame: Any) -> None:
        """Push one captured frame into the identified stream, triggering the
        deferred publish on the first frame. A stale id is a no-op."""
        ...

    async def remove_video_stream(self, stream_id: str) -> None:
        """Unpublish the identified stream. Identity-keyed and idempotent: a
        stale id is a no-op."""
        ...
