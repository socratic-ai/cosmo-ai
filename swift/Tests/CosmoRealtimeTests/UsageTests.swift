import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
@testable import CosmoRealtime

@Suite("Session usage")
struct UsageTests {

    private static let recordedBody = #"""
    {"status":"completed","usage_status":"recorded","duration_seconds":121.0,
     "turn_count":7,"user_speaking_seconds":41.5,"agent_speaking_seconds":63.25,
     "provider":"gemini","model":"gemini-3.1-flash-live-preview",
     "tokens":{"input_tokens":900,"output_tokens":400,"total_tokens":1300,
     "input_audio_tokens":700,"input_text_tokens":150,"input_image_tokens":20,
     "input_cached_tokens":30,"output_audio_tokens":350,"output_text_tokens":50}}
    """#

    // What the server sends while the session is live (or before the
    // detailed summary lands): the two statuses, the rest null.
    private static let pendingBody = #"""
    {"status":"active","usage_status":"pending","duration_seconds":null,
     "turn_count":null,"user_speaking_seconds":null,"agent_speaking_seconds":null,
     "provider":"gemini","model":null,"tokens":null}
    """#

    @Test("a 200 maps to the recorded summary with its token breakdown")
    func okMapsToRecordedSummary() async throws {
        let transport = StubTransport(onRequest: { request in
            #expect(request.method == .get)
            #expect(request.path == "/api/v1/external/sessions/sess-1/usage")
        }) { jsonResponse(.ok, Self.recordedBody) }
        let usage = try await makeStubClient(transport).sessionUsage(sessionId: "sess-1")
        #expect(usage.status == .completed)
        #expect(usage.usageStatus == .recorded)
        #expect(usage.durationSeconds == 121.0)
        #expect(usage.turnCount == 7)
        #expect(usage.userSpeakingSeconds == 41.5)
        #expect(usage.agentSpeakingSeconds == 63.25)
        #expect(usage.model == "gemini-3.1-flash-live-preview")
        #expect(usage.tokens?.inputTokens == 900)
        #expect(usage.tokens?.outputTokens == 400)
        #expect(usage.tokens?.totalTokens == 1300)
        #expect(usage.tokens?.inputCachedTokens == 30)
    }

    @Test("a pending summary comes back as a result, not an error")
    func pendingSummaryIsNotAnError() async throws {
        let transport = StubTransport { jsonResponse(.ok, Self.pendingBody) }
        let usage = try await makeStubClient(transport).sessionUsage(sessionId: "sess-1")
        #expect(usage.status == .active)
        #expect(usage.usageStatus == .pending)
        #expect(usage.durationSeconds == nil)
        #expect(usage.tokens == nil)
    }

    @Test("an undocumented rejection maps to UsageError.rejected with the parsed code/detail")
    func undocumentedRejectionMapsToRejected() async {
        let body = #"{"error":{"type":"api_error","code":"not_found","message":"voice session sess-1 not found"}}"#
        let transport = StubTransport { jsonResponse(.notFound, body) }
        await #expect {
            _ = try await makeStubClient(transport).sessionUsage(sessionId: "sess-1")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? UsageError else { return false }
            return code == "not_found" && detail.contains("not found")
        }
    }

    @Test("an auth-layer 401 maps to UsageError.rejected carrying the detail, with no code")
    func rejectionMapsToRejected() async {
        let body = #"{"detail":"Invalid API key"}"#
        let transport = StubTransport { jsonResponse(.unauthorized, body) }
        await #expect {
            _ = try await makeStubClient(transport).sessionUsage(sessionId: "sess-1")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? UsageError else { return false }
            return code == nil && detail == "Invalid API key"
        }
    }

    @Test("a 200 with an undecodable body maps to UsageError.invalidResponse")
    func undecodableSuccessBodyMapsToInvalidResponse() async {
        let transport = StubTransport { jsonResponse(.ok, "not json at all") }
        await #expect {
            _ = try await makeStubClient(transport).sessionUsage(sessionId: "sess-1")
        } throws: { error in
            guard case .invalidResponse(let message) = error as? UsageError else { return false }
            return !message.isEmpty
        }
    }

    @Test("a transport throw maps to UsageError.transport")
    func transportThrowMapsToTransport() async {
        let transport = StubTransport { throw StubError() }
        await #expect {
            _ = try await makeStubClient(transport).sessionUsage(sessionId: "sess-1")
        } throws: { error in
            guard case .transport(let message) = error as? UsageError else { return false }
            return !message.isEmpty
        }
    }
}
