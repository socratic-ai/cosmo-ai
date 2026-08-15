import CosmoRealtime
import Foundation
import Testing

// Deliberately a plain (non-@testable) import: pins that the reply contract
// is reachable as public API, so tool packs can bound replies against it.
@Suite struct ClientToolReplyTests {
    private func decode(_ reply: String) throws -> [String: JSONValue] {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(reply.utf8))
        guard case .object(let object) = value else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not an object"))
        }
        return object
    }

    // The ceiling's value is pinned against the shared contract vectors, in
    // ``SDKClientToolConformanceTests`` — retyping it here would be a fourth
    // place it can drift.

    @Test func successEnvelopeCarriesResultAndNullError() throws {
        let fields = try decode(ClientToolReply.envelope(ok: true, result: ["saved": .bool(true)]))
        #expect(Set(fields.keys) == ["ok", "result", "error"])
        #expect(fields["ok"] == .bool(true))
        #expect(fields["result"] == .object(["saved": .bool(true)]))
        #expect(fields["error"] == .null)
    }

    @Test func errorEnvelopeCarriesNullResult() throws {
        let fields = try decode(ClientToolReply.envelope(ok: false, error: "nope"))
        #expect(fields["ok"] == .bool(false))
        #expect(fields["result"] == .null)
        #expect(fields["error"] == .string("nope"))
    }

    @Test func omittedResultAndErrorEncodeAsNull() throws {
        let fields = try decode(ClientToolReply.envelope(ok: true))
        #expect(fields["result"] == .null)
        #expect(fields["error"] == .null)
    }

    @Test func rewrappedSizeMatchesTheDispatcherReWrap() throws {
        let result: [String: JSONValue] = [
            "content": .string("line one\nline two \"quoted\" 🙂"),
            "count": .int(2),
            "truncated": .bool(false),
        ]
        // What the RPC dispatcher does to a handler-built reply string:
        // decode it back into an object, then wrap that object as the
        // result of a fresh {ok: true} envelope.
        let inner = ClientToolReply.envelope(ok: true, result: result)
        let rewrapped = ClientToolReply.envelope(ok: true, result: try decode(inner))
        #expect(ClientToolReply.rewrappedSize(ok: true, result: result) == rewrapped.utf8.count)
        #expect(ClientToolReply.rewrappedSize(ok: true, result: result) > inner.utf8.count)
    }
}
