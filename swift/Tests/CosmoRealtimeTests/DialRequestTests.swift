import Foundation
import Testing
@testable import CosmoRealtime

/// Wire serialization of the hand-rolled outbound-dial REST call
/// (``RealtimeSession/_makeDialRequest``). The dial endpoint has no generated
/// client, so these pin the endpoint path, bearer auth, and the snake_case
/// request body — ``caller_number`` present only when a caller-ID is passed —
/// so a future backend rename can't drift silently.
@Suite("dial request serialization")
struct DialRequestTests {

    private func options(
        key: String = "cosmo_secret",
        base: String = "https://api.example.com"
    ) -> RealtimeSession.Options {
        var options = RealtimeSession.Options(apiKey: key)
        options.baseURL = URL(string: base)!
        return options
    }

    @Test("POSTs to the session dial path with bearer auth + JSON content-type")
    func requestShape() async throws {
        let req = try await RealtimeSession._makeDialRequest(
            options: options(),
            sessionId: "sess-1",
            phoneNumber: "+14155550199",
            callerNumber: nil
        )
        #expect(req.httpMethod == "POST")
        #expect(req.url?.absoluteString == "https://api.example.com/api/v1/external/realtime/session/sess-1/dial")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer cosmo_secret")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    @Test("body carries only phone_number when no caller-ID is passed")
    func bodyWithoutCaller() async throws {
        let req = try await RealtimeSession._makeDialRequest(
            options: options(),
            sessionId: "sess-1",
            phoneNumber: "+14155550199",
            callerNumber: nil
        )
        let json = try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]
        #expect(json?["phone_number"] as? String == "+14155550199")
        #expect(json?["caller_number"] == nil)
    }

    @Test("body carries caller_number when a caller-ID is passed")
    func bodyWithCaller() async throws {
        let req = try await RealtimeSession._makeDialRequest(
            options: options(),
            sessionId: "sess-1",
            phoneNumber: "+14155550199",
            callerNumber: "+12139458610"
        )
        let json = try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]
        #expect(json?["phone_number"] as? String == "+14155550199")
        #expect(json?["caller_number"] as? String == "+12139458610")
    }

    @Test("response decodes the snake_case dial_id")
    func responseDecode() throws {
        let wire = #"{"dial_id":"550e8400-e29b-41d4-a716-446655440000"}"#
        let resp = try JSONDecoder().decode(RealtimeSession.DialResponse.self, from: Data(wire.utf8))
        #expect(resp.dialId == "550e8400-e29b-41d4-a716-446655440000")
    }

    @Test("rejects a malformed number before any request")
    func rejectsMalformed() throws {
        #expect(throws: RealtimeSessionError.self) {
            try validateE164("not-a-number", field: "phone_number")
        }
        // A well-formed E.164 passes.
        try validateE164("+14155550199", field: "phone_number")
    }
}
