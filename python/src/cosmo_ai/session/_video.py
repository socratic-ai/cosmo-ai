"""The pushable handle a video stream is driven through."""

from __future__ import annotations

from typing import Any, Callable


class VideoStreamHandle:
    """A live video publish: push frames into it, hand it back to
    :meth:`~cosmo_ai.session.RealtimeSession.remove_video_stream` to stop.

    Returned by :meth:`~cosmo_ai.session.RealtimeSession.add_video_stream`;
    there is no other way to build one, because the id it carries is what the
    transport matches frames against. Pushing into a removed stream is inert
    rather than an error — a capture loop that outlives the stream by a frame
    or two is normal, not a bug to raise on.
    """

    def __init__(self, stream_id: str, push: Callable[[str, Any], None]) -> None:
        self._stream_id = stream_id
        self._push = push

    @property
    def stream_id(self) -> str:
        return self._stream_id

    def push(self, frame: Any) -> None:
        """Publish one captured frame — an ``rtc.VideoFrame``. Safe to call
        from a capture thread; the first push starts the publish."""
        self._push(self._stream_id, frame)
