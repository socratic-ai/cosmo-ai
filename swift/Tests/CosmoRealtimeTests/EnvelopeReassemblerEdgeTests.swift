import Foundation
import Testing
@testable import CosmoRealtime

@Suite("EnvelopeReassembler edge cases")
struct EnvelopeReassemblerEdgeTests {

    /// Helper: encode raw bytes for a chunk's `data` field.
    private func b64(_ data: Data) -> String { data.base64EncodedString() }

    @Test("Single-chunk envelope completes with decoded base64")
    func singleChunkCompletes() async {
        let r = EnvelopeReassembler()
        let payload = Data("hello world".utf8)
        let result = await r.consume(
            envelopeId: "env-single",
            seq: 0,
            total: 1,
            data: b64(payload)
        )
        guard case .complete(let out) = result else {
            Issue.record("expected .complete, got \(result)")
            return
        }
        #expect(out == payload)
    }

    @Test("Two-chunk envelope: first .pending, second .complete with concatenation")
    func twoChunkCompletes() async {
        let r = EnvelopeReassembler()
        let p0 = Data("foo".utf8)
        let p1 = Data("bar".utf8)
        let r0 = await r.consume(envelopeId: "env-2", seq: 0, total: 2, data: b64(p0))
        guard case .pending = r0 else {
            Issue.record("expected .pending after first chunk, got \(r0)")
            return
        }
        let r1 = await r.consume(envelopeId: "env-2", seq: 1, total: 2, data: b64(p1))
        guard case .complete(let out) = r1 else {
            Issue.record("expected .complete after second chunk, got \(r1)")
            return
        }
        #expect(out == Data("foobar".utf8))
    }

    @Test("Out-of-order delivery (seq=1 then seq=0) still completes correctly")
    func outOfOrderCompletes() async {
        let r = EnvelopeReassembler()
        let p0 = Data("AAA".utf8)
        let p1 = Data("BBB".utf8)
        _ = await r.consume(envelopeId: "env-oo", seq: 1, total: 2, data: b64(p1))
        let r0 = await r.consume(envelopeId: "env-oo", seq: 0, total: 2, data: b64(p0))
        guard case .complete(let out) = r0 else {
            Issue.record("expected .complete, got \(r0)")
            return
        }
        // Concatenation must respect seq order, not arrival order.
        #expect(out == Data("AAABBB".utf8))
    }

    @Test("seq out of range (negative, == total, > total) → .invalid \"seq/total out of range\"")
    func seqOutOfRangeIsInvalid() async {
        let r = EnvelopeReassembler()
        let bytes = b64(Data("x".utf8))

        for (seq, total) in [(-1, 2), (2, 2), (5, 2)] {
            let result = await r.consume(envelopeId: "env-range-\(seq)-\(total)", seq: seq, total: total, data: bytes)
            guard case .invalid(let msg) = result else {
                Issue.record("expected .invalid for seq=\(seq) total=\(total), got \(result)")
                continue
            }
            #expect(msg.contains("seq/total out of range"), "unexpected message: \(msg)")
        }
    }

    @Test("total <= 0 → .invalid")
    func totalNonPositiveIsInvalid() async {
        let r = EnvelopeReassembler()
        let bytes = b64(Data("x".utf8))
        for total in [0, -1] {
            let result = await r.consume(envelopeId: "env-total-\(total)", seq: 0, total: total, data: bytes)
            guard case .invalid = result else {
                Issue.record("expected .invalid for total=\(total), got \(result)")
                continue
            }
        }
    }

    @Test("Inconsistent total across chunks → .invalid and buffer cleared")
    func inconsistentTotalIsInvalid() async {
        let r = EnvelopeReassembler()
        // First chunk declares total=2.
        let r0 = await r.consume(envelopeId: "env-mix", seq: 0, total: 2, data: b64(Data("a".utf8)))
        guard case .pending = r0 else {
            Issue.record("expected .pending, got \(r0)")
            return
        }
        // Second chunk declares total=3 — must reject and clear.
        let r1 = await r.consume(envelopeId: "env-mix", seq: 1, total: 3, data: b64(Data("b".utf8)))
        guard case .invalid(let msg) = r1 else {
            Issue.record("expected .invalid for inconsistent total, got \(r1)")
            return
        }
        #expect(msg.contains("total inconsistent"))

        // Buffer should be cleared: reusing the envelopeId for a fresh
        // single-chunk envelope must succeed.
        let r2 = await r.consume(envelopeId: "env-mix", seq: 0, total: 1, data: b64(Data("z".utf8)))
        guard case .complete(let out) = r2 else {
            Issue.record("expected .complete after buffer clear, got \(r2)")
            return
        }
        #expect(out == Data("z".utf8))
    }

    @Test("Invalid base64 → .invalid and buffer cleared")
    func invalidBase64IsInvalid() async {
        let r = EnvelopeReassembler()
        // "!!!!" contains chars outside the base64 alphabet → Data(base64Encoded:) returns nil.
        let result = await r.consume(envelopeId: "env-b64", seq: 0, total: 2, data: "!!!!")
        guard case .invalid(let msg) = result else {
            Issue.record("expected .invalid for bad base64, got \(result)")
            return
        }
        #expect(msg.contains("invalid base64"))

        // Buffer cleared → reusing the id with valid input succeeds.
        let again = await r.consume(envelopeId: "env-b64", seq: 0, total: 1, data: b64(Data("ok".utf8)))
        guard case .complete = again else {
            Issue.record("expected .complete after buffer clear, got \(again)")
            return
        }
    }

    @Test("Byte cap exceeded → .invalid \"exceeded byte cap\" and buffer cleared")
    func byteCapExceeded() async {
        let r = EnvelopeReassembler()
        // Each chunk carries ~1MB of payload. After ~5 chunks, > 4MB cap.
        let mb: Int = 1024 * 1024
        let chunkPayload = Data(repeating: 0x41, count: mb)
        let total = 8  // declared total; we'll never reach it because of cap

        var sawInvalid = false
        for seq in 0..<total {
            let result = await r.consume(
                envelopeId: "env-bigcap",
                seq: seq,
                total: total,
                data: b64(chunkPayload)
            )
            if case .invalid(let msg) = result {
                #expect(msg.contains("byte cap"), "unexpected invalid msg: \(msg)")
                sawInvalid = true
                break
            }
        }
        #expect(sawInvalid, "expected byte-cap rejection before completion")

        // Buffer cleared → fresh envelope on same id succeeds.
        let fresh = await r.consume(envelopeId: "env-bigcap", seq: 0, total: 1, data: b64(Data("ok".utf8)))
        guard case .complete = fresh else {
            Issue.record("expected .complete after buffer clear, got \(fresh)")
            return
        }
    }

    @Test("In-flight envelope cap: opening (maxInflightEnvelopes + 1) returns .invalid \"too many in-flight envelopes\"")
    func inFlightCapExceeded() async {
        let r = EnvelopeReassembler()
        // Open maxInflightEnvelopes distinct envelopes; each stays pending.
        for i in 0..<maxInflightEnvelopes {
            let result = await r.consume(
                envelopeId: "env-flight-\(i)",
                seq: 0,
                total: 2,
                data: b64(Data("x".utf8))
            )
            guard case .pending = result else {
                Issue.record("expected .pending for envelope \(i), got \(result)")
                return
            }
        }
        // The next distinct envelope must be rejected.
        let overflow = await r.consume(
            envelopeId: "env-overflow",
            seq: 0,
            total: 2,
            data: b64(Data("y".utf8))
        )
        guard case .invalid(let msg) = overflow else {
            Issue.record("expected .invalid on overflow, got \(overflow)")
            return
        }
        #expect(msg.contains("too many in-flight envelopes"))
    }

    @Test("After .complete, the same envelopeId can be reused (buffer cleared)")
    func reuseAfterComplete() async {
        let r = EnvelopeReassembler()
        // First envelope completes.
        _ = await r.consume(envelopeId: "env-reuse", seq: 0, total: 2, data: b64(Data("ab".utf8)))
        let done = await r.consume(envelopeId: "env-reuse", seq: 1, total: 2, data: b64(Data("cd".utf8)))
        guard case .complete = done else {
            Issue.record("expected first envelope to complete, got \(done)")
            return
        }
        // Reuse the id — should be treated as a fresh envelope, not "in progress".
        _ = await r.consume(envelopeId: "env-reuse", seq: 0, total: 2, data: b64(Data("ef".utf8)))
        let done2 = await r.consume(envelopeId: "env-reuse", seq: 1, total: 2, data: b64(Data("gh".utf8)))
        guard case .complete(let out) = done2 else {
            Issue.record("expected reused envelope to complete, got \(done2)")
            return
        }
        #expect(out == Data("efgh".utf8))
    }

    @Test("After .invalid, the same envelopeId can be reused")
    func reuseAfterInvalid() async {
        let r = EnvelopeReassembler()
        // Trigger an invalid base64 error to clear the buffer.
        let bad = await r.consume(envelopeId: "env-reinvalid", seq: 0, total: 2, data: "!!!!")
        guard case .invalid = bad else {
            Issue.record("expected .invalid, got \(bad)")
            return
        }
        // Reusing the id with a valid 2-chunk envelope must succeed.
        let r0 = await r.consume(envelopeId: "env-reinvalid", seq: 0, total: 2, data: b64(Data("12".utf8)))
        guard case .pending = r0 else {
            Issue.record("expected .pending, got \(r0)")
            return
        }
        let r1 = await r.consume(envelopeId: "env-reinvalid", seq: 1, total: 2, data: b64(Data("34".utf8)))
        guard case .complete(let out) = r1 else {
            Issue.record("expected .complete, got \(r1)")
            return
        }
        #expect(out == Data("1234".utf8))
    }

    @Test("Stale-sweep is non-destructive within the TTL")
    func freshEnvelopeSurvivesShortDelay() async throws {
        // The TTL is injected rather than slept against: the reassembler ages
        // buffers off `Date()`, so a test that leans on "50ms is well under 30s"
        // is really asserting that it gets rescheduled promptly, which is not
        // true beside the rest of the suite. An hour of headroom makes the
        // delay irrelevant.
        let r = EnvelopeReassembler(ttl: 3600)
        _ = await r.consume(envelopeId: "env-fresh", seq: 0, total: 2, data: b64(Data("aa".utf8)))
        try await Task.sleep(for: .milliseconds(50))
        let r1 = await r.consume(envelopeId: "env-fresh", seq: 1, total: 2, data: b64(Data("bb".utf8)))
        guard case .complete(let out) = r1 else {
            Issue.record("expected envelope to still be alive within the TTL, got \(r1)")
            return
        }
        #expect(out == Data("aabb".utf8))
    }

    @Test("Stale-sweep drops a half-filled envelope past the TTL")
    func stalePartialEnvelopeIsSwept() async throws {
        // The positive half, which a wall-clock test could only reach by
        // sleeping out the real 30s TTL. Starvation only ages the buffer
        // further past an already-elapsed TTL, so this cannot flake the way
        // the negative case did.
        let r = EnvelopeReassembler(ttl: 0.01)
        _ = await r.consume(envelopeId: "env-stale", seq: 0, total: 2, data: b64(Data("aa".utf8)))
        try await Task.sleep(for: .milliseconds(50))
        // The first part is gone, so the envelope reopens holding only this
        // chunk and never completes — a dropped part must not be joinable.
        let r1 = await r.consume(envelopeId: "env-stale", seq: 1, total: 2, data: b64(Data("bb".utf8)))
        guard case .pending = r1 else {
            Issue.record("expected the swept envelope to reopen as pending, got \(r1)")
            return
        }
    }
}
