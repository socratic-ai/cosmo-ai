import AVFoundation
import Foundation
import LiveKit
import os.lock

/// LiveKit ``AudioRenderer`` that computes per-buffer RMS and pushes it
/// to an ``AsyncStream<Float>``. Throttled so a 100 Hz frame cadence
/// from LiveKit doesn't bombard the UI consumer with main-thread hops.
///
/// One instance per direction (mic vs. agent track). Attached by the
/// transport's room delegate once the corresponding track is published /
/// subscribed.
final class AudioLevelTap: NSObject, AudioRenderer, @unchecked Sendable {
    /// ~30 Hz emit rate. Matches an 80-sample sliding window ≈ 2.6 s of
    /// visible history for level-meter UIs.
    private static let minIntervalNanos: UInt64 = 33_000_000

    private let continuation: AsyncStream<Float>.Continuation
    private let lastEmitNanos = OSAllocatedUnfairLock<UInt64>(initialState: 0)

    init(continuation: AsyncStream<Float>.Continuation) {
        self.continuation = continuation
        super.init()
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let now = DispatchTime.now().uptimeNanoseconds
        let shouldEmit = lastEmitNanos.withLock { last -> Bool in
            if now &- last >= Self.minIntervalNanos {
                last = now
                return true
            }
            return false
        }
        guard shouldEmit else { return }
        continuation.yield(Self.rms(of: pcmBuffer))
    }

    static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        guard channelCount > 0, frameLength > 0 else { return 0 }
        if let p = buffer.floatChannelData {
            return rmsFloat(p, channelCount: channelCount, frameLength: frameLength)
        }
        if let p = buffer.int16ChannelData {
            return rmsInt16(p, channelCount: channelCount, frameLength: frameLength)
        }
        return 0
    }

    private static func rmsFloat(
        _ channelData: UnsafePointer<UnsafeMutablePointer<Float>>,
        channelCount: Int,
        frameLength: Int
    ) -> Float {
        var sumSq: Float = 0
        for ch in 0..<channelCount {
            let p = channelData[ch]
            for i in 0..<frameLength {
                let v = p[i]
                sumSq += v * v
            }
        }
        let rms = (sumSq / Float(channelCount * frameLength)).squareRoot()
        return min(max(rms, 0), 1)
    }

    private static func rmsInt16(
        _ channelData: UnsafePointer<UnsafeMutablePointer<Int16>>,
        channelCount: Int,
        frameLength: Int
    ) -> Float {
        var sumSq: Float = 0
        for ch in 0..<channelCount {
            let p = channelData[ch]
            for i in 0..<frameLength {
                let v = Float(p[i]) / 32768.0
                sumSq += v * v
            }
        }
        let rms = (sumSq / Float(channelCount * frameLength)).squareRoot()
        return min(max(rms, 0), 1)
    }
}
