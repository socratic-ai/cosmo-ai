import CoreMedia
import Foundation

// MARK: - Screen share
extension RealtimeSession {

    /// Start a screen-share publish. The video track is created
    /// immediately but the SFU publish is deferred until the first
    /// ``pushScreenShareFrame(_:)`` arrives, since the capturer needs at
    /// least one frame to resolve dimensions. Idempotent: any prior
    /// share is stopped first. Throws ``RealtimeSessionError/notConnected``
    /// if the session is not live.
    public func startScreenShare() async throws {
        try await transport.startScreenShare()
    }

    /// Push one captured frame into the active screen-share publish.
    /// Safe to call from a video-capture thread. The first call kicks
    /// off the deferred publish; later calls feed the publishing track.
    /// No-op before ``startScreenShare()`` or after ``stopScreenShare()``.
    public nonisolated func pushScreenShareFrame(_ sampleBuffer: CMSampleBuffer) {
        transport.pushScreenShareFrame(sampleBuffer)
    }

    /// Stop the active screen-share publish. Idempotent.
    public func stopScreenShare() async {
        await transport.stopScreenShare()
    }

    /// Install or clear a frame processor run inside
    /// ``pushScreenShareFrame(_:)`` before each frame reaches the
    /// capturer. Pass ``nil`` to remove a previously-installed processor.
    public nonisolated func setScreenShareFrameProcessor(_ processor: ScreenShareFrameProcessor?) {
        transport.setScreenShareFrameProcessor(processor)
    }

    /// Register a callback fired when the deferred screen-share publish
    /// fails (SFU rejection, codec mismatch, network blip). Share state
    /// is cleared before the callback fires, so the handler may restart
    /// the share by calling ``startScreenShare()`` again. Returns a
    /// ``Cancellable`` to drop the listener.
    public nonisolated func onScreenShareFailed(
        _ handler: @escaping @Sendable (Error) -> Void
    ) -> Cancellable {
        transport.onScreenShareFailed(handler)
    }
}

// MARK: - Video streams
extension RealtimeSession {

    /// Publish a non-screen video stream (camera, file, any pixels-only
    /// stream) and return its pushable handle — the frame sink the
    /// caller feeds captured ``CMSampleBuffer``s into. The publish is
    /// deferred until the first pushed frame, same as
    /// ``startScreenShare()``. One video publish at a time: throws
    /// ``RealtimeSessionError/videoPublishAlreadyActive`` while another
    /// video publish (stream or share) is live, and
    /// ``RealtimeSessionError/notConnected`` outside a live session.
    /// Publish failures surface on ``onScreenShareFailed(_:)``.
    public func addVideoStream() async throws -> VideoStreamHandle {
        try await transport.addVideoStream()
    }

    /// Remove a video stream added by ``addVideoStream()``. Identity-keyed
    /// and idempotent: a stale handle is a no-op, and pushes into a
    /// removed handle are safely inert.
    public func removeVideoStream(_ handle: VideoStreamHandle) async {
        await transport.removeVideoStream(handle)
    }
}
