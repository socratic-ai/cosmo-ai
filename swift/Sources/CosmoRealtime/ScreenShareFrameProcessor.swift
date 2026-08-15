import CoreMedia
import Foundation

/// Optional hook installed by SDK consumers to transform every captured
/// screen-share frame before LiveKit publishes it. Returning ``nil`` is
/// equivalent to passing the original buffer through untouched, so a
/// processor that errors out cannot break the publish path.
///
/// The closure is invoked synchronously on the capture thread, so
/// implementations must be cheap and thread-safe.
public typealias ScreenShareFrameProcessor = @Sendable (CMSampleBuffer) -> CMSampleBuffer?
