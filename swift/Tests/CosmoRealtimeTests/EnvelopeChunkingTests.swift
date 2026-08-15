import Foundation
import Testing
@testable import CosmoRealtime

@Suite("Outbound envelope chunking")
struct OutboundChunkingTests {

    @Test("Small payloads pass through as a single packet, no envelope id")
    func smallPayloadIsSinglePacket() {
        let payload = Data("\"hello\"".utf8)
        let result = buildOutboundPackets(payload)
        #expect(result.packets.count == 1)
        #expect(result.packets[0] == payload)
        #expect(result.envelopeId == nil)
    }

    @Test("Payload exactly at safePacketBytes is not chunked")
    func boundaryAtSafePacketBytes() {
        let payload = Data(repeating: 0x61, count: safePacketBytes)
        let result = buildOutboundPackets(payload)
        #expect(result.packets.count == 1)
        #expect(result.envelopeId == nil)
    }

    @Test("Payload one byte over safePacketBytes triggers chunking")
    func aboveBoundaryChunks() {
        let payload = Data(repeating: 0x61, count: safePacketBytes + 1)
        let result = buildOutboundPackets(payload)
        #expect(result.packets.count > 1)
        #expect(result.envelopeId != nil)
    }

    @Test("Chunk count matches ceil(payload / chunkRawBytes)")
    func chunkCountIsCorrect() {
        let size = chunkRawBytes * 3 + 17  // 4 chunks, last partial
        let payload = Data(repeating: 0x62, count: size)
        let result = buildOutboundPackets(payload)
        #expect(result.packets.count == 4)
    }

    @Test("Each chunk fits under safePacketBytes after JSON + base64 overhead")
    func chunksRespectWireBudget() {
        let size = chunkRawBytes * 5
        let payload = Data(repeating: 0x63, count: size)
        let result = buildOutboundPackets(payload)
        for packet in result.packets {
            #expect(packet.count <= safePacketBytes,
                    "packet of \(packet.count) bytes exceeds safePacketBytes (\(safePacketBytes))")
        }
    }

    @Test("All chunks share the same envelope_id, seq covers 0..<total")
    func chunkMetadataIsConsistent() throws {
        let payload = Data(repeating: 0x64, count: chunkRawBytes * 3 + 1)
        let result = buildOutboundPackets(payload)
        let total = result.packets.count
        #expect(total == 4)
        var seenIds: Set<String> = []
        var seenSeqs: Set<Int> = []
        for packet in result.packets {
            guard let json = try JSONSerialization.jsonObject(with: packet) as? [String: Any] else {
                Issue.record("chunk is not valid JSON object")
                continue
            }
            #expect(json["type"] as? String == "envelope-chunk")
            if let id = json["envelope_id"] as? String { seenIds.insert(id) }
            if let seq = json["seq"] as? Int { seenSeqs.insert(seq) }
            #expect(json["total"] as? Int == total)
            #expect(json["data"] is String)
        }
        #expect(seenIds.count == 1)
        #expect(seenSeqs == Set(0..<total))
    }

    @Test("Chunks reassemble byte-equivalent via EnvelopeReassembler")
    func chunksReassembleToOriginal() async throws {
        let original = Data((0..<(chunkRawBytes * 4 + 123)).map { UInt8($0 & 0xff) })
        let outbound = buildOutboundPackets(original)
        let reassembler = EnvelopeReassembler()
        var assembled: Data?
        for packet in outbound.packets {
            let json = try #require(try JSONSerialization.jsonObject(with: packet) as? [String: Any])
            let envelopeId = try #require(json["envelope_id"] as? String)
            let seq = try #require(json["seq"] as? Int)
            let total = try #require(json["total"] as? Int)
            let dataB64 = try #require(json["data"] as? String)
            let r = await reassembler.consume(
                envelopeId: envelopeId,
                seq: seq,
                total: total,
                data: dataB64
            )
            if case .complete(let inner) = r {
                assembled = inner
            }
        }
        #expect(assembled == original)
    }

    @Test("Pre-chunked envelope-chunk payload is refused (empty packets)")
    func nestedEnvelopeIsRefused() throws {
        // A massive payload already declaring itself as envelope-chunk.
        // The chunker must not wrap this again.
        let inner: [String: Any] = [
            "type": "envelope-chunk",
            "envelope_id": "abc",
            "seq": 0,
            "total": 1,
            "data": String(repeating: "A", count: safePacketBytes * 2),
        ]
        let payload = try JSONSerialization.data(withJSONObject: inner)
        let result = buildOutboundPackets(payload)
        #expect(result.packets.isEmpty)
    }
}
