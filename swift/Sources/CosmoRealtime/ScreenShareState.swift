import Foundation
import LiveKit

/// State for an active video publish — a screen share or a camera-class
/// video stream; the single slot holds one at a time. Created upfront on
/// start but the LiveKit publish is deferred until the first pushed
/// frame — ``BufferCapturer`` needs at least one ``CMSampleBuffer`` to
/// resolve video dimensions, otherwise ``publish(videoTrack:)`` waits
/// indefinitely for the SFU.
final class ScreenShareState: @unchecked Sendable {
    let track: LocalVideoTrack
    let capturer: BufferCapturer
    let source: Track.Source
    let streamID = UUID()
    var publication: LocalTrackPublication?
    var publishTask: Task<Void, Never>?

    init(
        track: LocalVideoTrack,
        capturer: BufferCapturer,
        source: Track.Source = .screenShareVideo
    ) {
        self.track = track
        self.capturer = capturer
        self.source = source
    }
}
