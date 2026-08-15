import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import CosmoRealtime

@Suite("RealtimeSession media sends")
struct SessionMediaSendTests {

    private static func context(width: Int, height: Int) throws -> CGContext {
        try #require(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            )
        )
    }

    /// Rejoin the ``envelope-chunk`` packets an image send is split into.
    /// Anything above `safePacketBytes` (12 KB) is chunked, so every realistic
    /// frame arrives in pieces.
    static func reassemble(_ packets: some Collection<Data>) -> ObservedEvent? {
        let frames = packets.map(observeSentFrame).filter { $0.type != "bind-input" }
        if let single = frames.first, single.type == "send-image", frames.count == 1 {
            return single
        }
        let chunks = frames.filter { $0.type == "envelope-chunk" }
        guard !chunks.isEmpty else { return frames.first }
        var parts: [(Int, Data)] = []
        for chunk in chunks {
            guard
                case .int(let seq)? = chunk.fields["seq"],
                case .string(let encoded)? = chunk.fields["data"],
                let slice = Data(base64Encoded: encoded)
            else {
                return nil
            }
            parts.append((seq, slice))
        }
        let payload = parts.sorted { $0.0 < $1.0 }.reduce(into: Data()) { $0.append($1.1) }
        return observeSentFrame(payload)
    }

    /// Dimensions straight off the encoded bytes, so a test asserting what was
    /// sent never routes through the code under test to find out.
    static func pixelSize(base64: String) -> (width: Int, height: Int)? {
        guard
            let data = Data(base64Encoded: base64),
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = props[kCGImagePropertyPixelWidth] as? Int,
            let height = props[kCGImagePropertyPixelHeight] as? Int
        else {
            return nil
        }
        return (width, height)
    }

    /// Deterministic high-entropy fill. Noise is the worst case for JPEG, so
    /// these fixtures are far heavier than a real screenshot at the same
    /// dimensions — fine for driving the size branches, useless for
    /// calibrating a byte threshold against real content.
    static func noiseImage(width: Int, height: Int) throws -> CGImage {
        let ctx = try context(width: width, height: height)
        var seed: UInt64 = 0x9E3779B97F4A7C15
        var next: () -> Double = {
            seed ^= seed << 13
            seed ^= seed >> 7
            seed ^= seed << 17
            return Double(seed % 1000) / 1000.0
        }
        for x in stride(from: 0, to: width, by: 4) {
            for y in stride(from: 0, to: height, by: 4) {
                ctx.setFillColor(
                    CGColor(red: next(), green: next(), blue: next(), alpha: 1)
                )
                ctx.fill(CGRect(x: x, y: y, width: 4, height: 4))
            }
        }
        return try #require(ctx.makeImage())
    }

    private func startedSession() async throws -> (RealtimeSession, FakeSessionTransport) {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())
        return (session, transport)
    }

    /// The frames the session handed the transport, minus the leading
    /// ``session-config`` start payload and the ``bind-input`` frame the
    /// session emits on start (this client is the voice), normalized to the
    /// trace vocabulary (wire ``type`` + JSON fields).
    private func sentSends(_ transport: FakeSessionTransport) async -> [ObservedEvent] {
        await transport.sent
            .dropFirst()
            .map(observeSentFrame)
            .filter { $0.type != "bind-input" }
    }

    @Test("start() binds the agent input as the voice")
    func startBindsInput() async throws {
        let (_, transport) = try await startedSession()
        // After the leading session-config, the session binds the agent's
        // input so it listens to this client.
        let frames = await transport.sent.dropFirst().map(observeSentFrame)
        let bind = try #require(frames.first { $0.type == "bind-input" })
        #expect(Set(bind.fields.keys) == ["type"])
    }

    @Test("send(image:) records send-image with documented defaults")
    func sendImageDefaults() async throws {
        let (session, transport) = try await startedSession()
        try await session.send(image: "YWJj")

        let sends = await sentSends(transport)
        #expect(sends.count == 1)
        let frame = try #require(sends.first)
        #expect(frame.type == "send-image")
        #expect(frame.fields["data"] == .string("YWJj"))
        #expect(frame.fields["mime_type"] == .string("image/jpeg"))
        #expect(frame.fields["stream_id"] == .string("video.input.default"))
    }

    @Test("send(image:) carries explicit mime type and stream id")
    func sendImageExplicit() async throws {
        let (session, transport) = try await startedSession()
        try await session.send(image: "ZGVm", mimeType: "image/png", streamId: "video.input.screen")

        let frame = try #require(await sentSends(transport).first)
        #expect(frame.type == "send-image")
        #expect(frame.fields["data"] == .string("ZGVm"))
        #expect(frame.fields["mime_type"] == .string("image/png"))
        #expect(frame.fields["stream_id"] == .string("video.input.screen"))
    }

    @Test("_bounded re-encodes an over-resolution frame down to the recommended edge")
    func boundedDownscalesOversized() throws {
        // Noise, not a flat fill: a solid image compresses so far that no
        // resolution would clear the threshold, and the test would pass
        // without exercising anything.
        let oversized = try ImageDownscale.encodeJPEG(
            image: try Self.noiseImage(width: 3200, height: 2000),
            maxLongEdge: 3200
        )
        #expect(oversized.base64.count > RealtimeSession.imageBase64InspectThreshold)

        var mimeType = "image/jpeg"
        var reencode: RealtimeSession.ReencodeNote?
        let bounded = try RealtimeSession._bounded(
            base64: oversized.base64,
            originalLength: oversized.base64.count,
            mimeType: &mimeType,
            reencode: &reencode
        )
        #expect(bounded.count < oversized.base64.count)
        #expect(mimeType == "image/jpeg")
        let size = try #require(Self.pixelSize(base64: bounded))
        #expect(max(size.width, size.height) == ImageDownscale.recommendedMaxLongEdge)
    }

    @Test("_bounded passes through a big frame that is already within the pixel bound")
    func boundedPassesThroughWithinPixelBound() throws {
        // Within the pixel ceiling but heavy on the wire — re-encoding would
        // cost a lossy round trip and buy nothing.
        let heavy = try ImageDownscale.encodeJPEG(
            image: try Self.noiseImage(width: 1280, height: 1280),
            quality: 1.0
        )
        #expect(heavy.base64.count > RealtimeSession.imageBase64InspectThreshold)

        var mimeType = "image/jpeg"
        var reencode: RealtimeSession.ReencodeNote?
        let bounded = try RealtimeSession._bounded(
            base64: heavy.base64,
            originalLength: heavy.base64.count,
            mimeType: &mimeType,
            reencode: &reencode
        )
        #expect(bounded == heavy.base64)
    }

    @Test("_bounded rejects an undownscalable payload past the hard limit")
    func boundedRejectsUnsendable() throws {
        let junk = String(repeating: "A", count: RealtimeSession.maxImageBase64Length + 4)
        var mimeType = "image/jpeg"
        var reencode: RealtimeSession.ReencodeNote?
        let expected = ImageDownscale.Error.payloadTooLarge(
            base64Length: junk.count,
            limit: RealtimeSession.maxImageBase64Length,
            recommendedLongEdge: ImageDownscale.recommendedMaxLongEdge
        )
        #expect(throws: expected) {
            try RealtimeSession._bounded(
                base64: junk,
                originalLength: junk.count,
                mimeType: &mimeType,
                reencode: &reencode
            )
        }
        #expect(reencode == nil)
    }

    /// A raised ceiling has to survive the send path. Routing this overload
    /// through the base64 one silently re-clamped it to the default.
    @Test("send(image:maxLongEdge:) honours a ceiling above the default")
    func sendCGImageHonoursRaisedCeiling() async throws {
        let (session, transport) = try await startedSession()
        try await session.send(image: try Self.noiseImage(width: 2048, height: 2048), maxLongEdge: 2048)

        let packets = await transport.sent.dropFirst()
        let reassembled = try #require(Self.reassemble(packets))
        guard case .string(let sent)? = reassembled.fields["data"] else {
            Issue.record("send-image carried no string data field")
            return
        }
        let size = try #require(Self.pixelSize(base64: sent))
        #expect(max(size.width, size.height) == 2048)
    }

    @Test("_bounded lets an undownscalable but sendable payload through")
    func boundedAllowsUndecodableUnderLimit() throws {
        let junk = String(repeating: "A", count: RealtimeSession.imageBase64InspectThreshold + 4)
        var mimeType = "image/jpeg"
        var reencode: RealtimeSession.ReencodeNote?
        let bounded = try RealtimeSession._bounded(
            base64: junk,
            originalLength: junk.count,
            mimeType: &mimeType,
            reencode: &reencode
        )
        #expect(bounded == junk)
    }

    @Test("send(bytes:topic:) streams the payload to the transport on the topic")
    func sendBytes() async throws {
        let (session, transport) = try await startedSession()
        let payload = Data("grounding".utf8)
        try await session.send(bytes: payload, topic: "grounding.capture")

        let streamed = await transport.sentBytes
        #expect(streamed.count == 1)
        #expect(streamed.first?.data == payload)
        #expect(streamed.first?.topic == "grounding.capture")
    }

    @Test("send(bytes:) throws notConnected before start")
    func sendBytesRejectsBeforeStart() async {
        let session = RealtimeSession(transport: FakeSessionTransport())
        await #expect(throws: RealtimeSessionError.notConnected) {
            try await session.send(bytes: Data("x".utf8), topic: "t")
        }
    }

    @Test("sendActivityEnd() records a bare activity-end frame")
    func activityEnd() async throws {
        let (session, transport) = try await startedSession()
        try await session.sendActivityEnd()

        let sends = await sentSends(transport)
        #expect(sends.count == 1)
        let frame = try #require(sends.first)
        #expect(frame.type == "activity-end")
        // activity-end carries only the discriminator.
        #expect(Set(frame.fields.keys) == ["type"])
    }

    @Test("media sends throw notConnected before start")
    func mediaSendsRejectBeforeStart() async {
        let session = RealtimeSession(transport: FakeSessionTransport())
        await #expect(throws: RealtimeSessionError.notConnected) {
            try await session.send(image: "YWJj")
        }
        await #expect(throws: RealtimeSessionError.notConnected) {
            try await session.sendActivityEnd()
        }
    }

    @Test("media sends throw notConnected after end")
    func mediaSendsRejectAfterEnd() async throws {
        let (session, _) = try await startedSession()
        await session.end()
        await #expect(throws: RealtimeSessionError.notConnected) {
            try await session.send(image: "YWJj")
        }
        await #expect(throws: RealtimeSessionError.notConnected) {
            try await session.sendActivityEnd()
        }
    }
}
