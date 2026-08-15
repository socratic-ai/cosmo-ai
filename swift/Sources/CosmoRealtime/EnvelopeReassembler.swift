import Foundation

// MARK: - Envelope protocol constants
//
// Wire-protocol constants shared with the sibling Python and TypeScript
// SDKs. Names are spelled lowerCamel here per Swift convention; the
// values are the source of truth for chunk budgeting.

/// Per-packet wire budget for ``localParticipant.publish(data:)``.
/// LiveKit's reliable channel accepts larger packets but we keep a
/// comfortable margin to absorb base64 + envelope JSON overhead.
let safePacketBytes = 12_000
/// Inner-bytes budget per chunk before base64 + JSON wrapping. Keeps
/// the resulting envelope JSON under ``safePacketBytes``.
let chunkRawBytes = 8_000

let maxInflightEnvelopes = 8
let maxInflightEnvelopeBytes = 4 * 1024 * 1024
let envelopeTTL: TimeInterval = 30

// MARK: - Outbound chunking

/// Result of preparing an outbound message for the wire.
struct OutboundPackets {
    /// JSON-encoded packets to publish over the data channel, in order.
    /// Single-element when the input fit under ``safePacketBytes``;
    /// multi-element when chunked into ``envelope-chunk`` packets.
    let packets: [Data]
    /// Shared envelope id when the message was chunked, ``nil`` otherwise.
    /// Surfaced for logging / metrics; the wire payload already carries it.
    let envelopeId: String?
}

/// Build the wire packets for one outbound client message.
///
/// Small messages (``<= safePacketBytes``) pass through as a single
/// packet. Oversized messages are split into ``envelope-chunk`` packets
/// sharing one ``envelopeId``. Mirrors the TS ``buildOutboundPackets``
/// and the Python ``build_outbound_packets`` so all three languages
/// produce byte-identical wire shapes.
///
/// Refusing to chunk an already-chunked ``envelope-chunk`` message is
/// represented as an empty ``packets`` array — nesting envelopes is
/// never legal and the caller must log + drop.
func buildOutboundPackets(_ payload: Data) -> OutboundPackets {
    if payload.count <= safePacketBytes {
        return OutboundPackets(packets: [payload], envelopeId: nil)
    }
    // Refuse to chunk an already-chunked envelope. Probe the type
    // discriminator on the JSON; cheap and unambiguous since the type
    // is the wire-level identity.
    if let json = try? JSONSerialization.jsonObject(with: payload, options: []) as? [String: Any],
       let type = json["type"] as? String,
       type == "envelope-chunk" {
        return OutboundPackets(packets: [], envelopeId: nil)
    }
    let envelopeId = UUID().uuidString
    var slices: [Data] = []
    var offset = 0
    while offset < payload.count {
        let end = min(offset + chunkRawBytes, payload.count)
        slices.append(payload.subdata(in: offset..<end))
        offset = end
    }
    var packets: [Data] = []
    packets.reserveCapacity(slices.count)
    for (seq, slice) in slices.enumerated() {
        let chunk: [String: Any] = [
            "type": "envelope-chunk",
            "envelope_id": envelopeId,
            "seq": seq,
            "total": slices.count,
            "data": slice.base64EncodedString(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: chunk, options: [.sortedKeys]) else {
            // JSONSerialization on a hand-built dict of String/Int/String
            // values cannot realistically fail; if it ever did, dropping
            // the chunk would corrupt the envelope, so fail loudly.
            return OutboundPackets(packets: [], envelopeId: envelopeId)
        }
        packets.append(data)
    }
    return OutboundPackets(packets: packets, envelopeId: envelopeId)
}

struct EnvelopeBuffer {
    let total: Int
    var parts: [Int: Data]
    let createdAt: Date
    var bytesSoFar: Int
}

/// Reassembles inbound ``server-envelope-chunk`` packets into a single
/// JSON payload, mirroring the TS ``EnvelopeReassembler``.
actor EnvelopeReassembler {
    private var buffers: [String: EnvelopeBuffer] = [:]

    /// How long a partially-filled envelope survives before the sweep drops it.
    /// Injectable so tests can pin both sides of the boundary against elapsed
    /// wall time they do not control.
    private let ttl: TimeInterval

    init(ttl: TimeInterval = envelopeTTL) {
        self.ttl = ttl
    }

    enum Result {
        case pending
        case complete(Data)
        case invalid(String)
    }

    func consume(
        envelopeId: String,
        seq: Int,
        total: Int,
        data: String
    ) -> Result {
        sweepStale()

        guard seq >= 0, total > 0, seq < total else {
            return .invalid("seq/total out of range: seq=\(seq) total=\(total)")
        }

        if buffers[envelopeId] == nil {
            guard buffers.count < maxInflightEnvelopes else {
                return .invalid("too many in-flight envelopes")
            }
            buffers[envelopeId] = EnvelopeBuffer(
                total: total,
                parts: [:],
                createdAt: Date(),
                bytesSoFar: 0
            )
        }

        guard var buf = buffers[envelopeId] else {
            return .invalid("buffer missing after init")
        }

        guard buf.total == total else {
            buffers.removeValue(forKey: envelopeId)
            return .invalid("envelope total inconsistent")
        }

        guard let decoded = Data(base64Encoded: data) else {
            buffers.removeValue(forKey: envelopeId)
            return .invalid("invalid base64 in envelope chunk")
        }

        buf.bytesSoFar += decoded.count
        guard buf.bytesSoFar <= maxInflightEnvelopeBytes else {
            buffers.removeValue(forKey: envelopeId)
            return .invalid("envelope exceeded byte cap")
        }

        buf.parts[seq] = decoded
        buffers[envelopeId] = buf

        guard buf.parts.count == total else { return .pending }

        buffers.removeValue(forKey: envelopeId)
        var joined = Data()
        for i in 0..<total {
            guard let part = buf.parts[i] else {
                return .invalid("missing part \(i)")
            }
            joined.append(part)
        }
        return .complete(joined)
    }

    private func sweepStale() {
        let now = Date()
        buffers = buffers.filter { now.timeIntervalSince($0.value.createdAt) < ttl }
    }
}
