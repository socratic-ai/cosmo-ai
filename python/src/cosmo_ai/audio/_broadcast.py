"""Agent-audio fan-out and level math — vendor-free session plumbing.

The transport delivers the agent's decoded voice as
:class:`~cosmo_ai.audio.AgentAudioFrame`; the broadcaster
fans each frame out to independently-paced consumers (``agent_audio()``
iterators, the speaker sink, the levels sampler). A stalled consumer drops its
oldest frames rather than growing memory or lagging the others.
"""

from __future__ import annotations

import asyncio
import math
from array import array
from typing import Callable

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.audio import AgentAudioFrame

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

_CONSUMER_QUEUE_MAX_FRAMES = 200  # ~2 s of 10 ms frames


def rms_int16(data: bytes) -> float:
    """RMS of 16-bit little-endian PCM, normalized to 0…1."""
    if not data:
        return 0.0
    samples = array("h", data)
    return math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768.0


class AgentAudioConsumer:
    """One fan-out subscriber: a bounded queue drained by async iteration.
    ``None`` is the finish sentinel."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[AgentAudioFrame | None] = asyncio.Queue(
            maxsize=_CONSUMER_QUEUE_MAX_FRAMES
        )
        self._overflow_warned = False

    def _put_evicting_oldest(self, item: AgentAudioFrame | None) -> None:
        while True:
            try:
                self._queue.put_nowait(item)
                return
            except asyncio.QueueFull:
                if not self._overflow_warned:
                    self._overflow_warned = True
                    logger.warning(
                        "realtime.agent_audio_consumer_lagging",
                        queue_max_frames=_CONSUMER_QUEUE_MAX_FRAMES,
                    )
                try:
                    self._queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass

    def _finish(self) -> None:
        self._put_evicting_oldest(None)

    def __aiter__(self) -> "AgentAudioConsumer":
        return self

    async def __anext__(self) -> AgentAudioFrame:
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item


class AgentAudioBroadcaster:
    """Fan-out registry implementing the transport's ``AgentAudioSink``.

    ``on_first_consumer`` / ``on_last_consumer`` fire on the 0→1 / 1→0
    consumer-count edges so the owner can create and release the decode
    pipeline lazily. ``close`` finishes every consumer and latches: late
    subscribers finish immediately and the pipeline is never re-activated."""

    def __init__(
        self,
        *,
        on_first_consumer: Callable[[], None],
        on_last_consumer: Callable[[], None],
    ) -> None:
        self._on_first_consumer = on_first_consumer
        self._on_last_consumer = on_last_consumer
        self._consumers: list[AgentAudioConsumer] = []
        self._closed = False

    def subscribe(self) -> AgentAudioConsumer:
        consumer = AgentAudioConsumer()
        if self._closed:
            consumer._finish()
            return consumer
        self._consumers.append(consumer)
        if len(self._consumers) == 1:
            self._on_first_consumer()
        return consumer

    def unsubscribe(self, consumer: AgentAudioConsumer) -> None:
        if consumer not in self._consumers:
            return
        self._consumers.remove(consumer)
        consumer._finish()
        if not self._consumers and not self._closed:
            self._on_last_consumer()

    def deliver(self, frame: AgentAudioFrame) -> None:
        for consumer in self._consumers:
            consumer._put_evicting_oldest(frame)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        consumers, self._consumers = self._consumers, []
        for consumer in consumers:
            consumer._finish()
