import CoreMedia
import Foundation

/// A live non-screen video publish (camera, file, any pixels-only
/// stream), returned by ``RealtimeSession/addVideoStream()``.
///
/// The handle is the frame sink: Apple platforms deliver capture as
/// per-frame ``CMSampleBuffer`` callbacks with no self-producing stream
/// object, so where the TypeScript SDK passes a `MediaStream` *in*, this
/// SDK hands a sink *back*. Push captured frames into it and pass it to
/// ``RealtimeSession/removeVideoStream(_:)`` to unpublish.
public final class VideoStreamHandle: Sendable {
    let streamID: UUID
    private let pushFrame: @Sendable (CMSampleBuffer) -> Void

    init(streamID: UUID, pushFrame: @escaping @Sendable (CMSampleBuffer) -> Void) {
        self.streamID = streamID
        self.pushFrame = pushFrame
    }

    /// Push one captured frame into this stream's publish. Safe to call
    /// from a video-capture thread. The first call kicks off the deferred
    /// LiveKit publish; calls after ``RealtimeSession/removeVideoStream(_:)``
    /// are safely inert.
    public func push(_ sampleBuffer: CMSampleBuffer) {
        pushFrame(sampleBuffer)
    }
}
