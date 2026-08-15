import AVFoundation
import Testing
@testable import CosmoRealtime

@Suite struct AudioLevelTapTests {
    @Test func rmsFloatSilenceIsZero() {
        let buffer = makeFloatBuffer(channels: 1, frames: 480, fill: 0)
        #expect(AudioLevelTap.rms(of: buffer) == 0)
    }

    @Test func rmsFloatHalfAmplitudeDC() {
        let buffer = makeFloatBuffer(channels: 1, frames: 480, fill: 0.5)
        let rms = AudioLevelTap.rms(of: buffer)
        #expect(approx(rms, 0.5))
    }

    @Test func rmsFloatFullScaleSineIsRoot2() {
        // sin(2π·t) over an integer number of periods → RMS == √2/2 ≈ 0.707.
        let frames = 480
        let buffer = makeFloatBuffer(channels: 1, frames: frames, fill: 0)
        if let channel = buffer.floatChannelData?[0] {
            for i in 0..<frames {
                channel[i] = Float(sin(2 * .pi * Double(i) / Double(frames) * 10))
            }
        }
        let rms = AudioLevelTap.rms(of: buffer)
        #expect(approx(rms, sqrt(2) / 2, tol: 0.01))
    }

    @Test func rmsInt16HalfAmplitudeDC() {
        let buffer = makeInt16Buffer(channels: 1, frames: 480, fill: 16384)
        let rms = AudioLevelTap.rms(of: buffer)
        #expect(approx(rms, 0.5, tol: 0.001))
    }

    @Test func rmsClampsToOne() {
        let buffer = makeFloatBuffer(channels: 1, frames: 480, fill: 2.0)
        let rms = AudioLevelTap.rms(of: buffer)
        #expect(rms <= 1.0)
    }

    @Test func throttleSkipsBackToBackRenders() async throws {
        // Two render() calls within the 33 ms throttle window must yield
        // only once; a third call after the window yields again.
        let (stream, continuation) = AsyncStream<Float>.makeStream()
        let tap = AudioLevelTap(continuation: continuation)
        let buffer = makeFloatBuffer(channels: 1, frames: 480, fill: 0.5)

        tap.render(pcmBuffer: buffer)
        tap.render(pcmBuffer: buffer)
        try await Task.sleep(for: .milliseconds(50))
        tap.render(pcmBuffer: buffer)
        continuation.finish()

        var collected: [Float] = []
        for await level in stream { collected.append(level) }
        #expect(collected.count == 2)
        #expect(approx(collected[0], 0.5))
        #expect(approx(collected[1], 0.5))
    }
}

private func makeFloatBuffer(channels: AVAudioChannelCount, frames: Int, fill: Float) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: channels, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    if let channelData = buffer.floatChannelData {
        for ch in 0..<Int(channels) {
            let p = channelData[ch]
            for i in 0..<frames { p[i] = fill }
        }
    }
    return buffer
}

private func makeInt16Buffer(channels: AVAudioChannelCount, frames: Int, fill: Int16) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: channels, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    if let channelData = buffer.int16ChannelData {
        for ch in 0..<Int(channels) {
            let p = channelData[ch]
            for i in 0..<frames { p[i] = fill }
        }
    }
    return buffer
}

private func approx(_ a: Float, _ b: Float, tol: Float = 1e-5) -> Bool {
    abs(a - b) <= tol
}
