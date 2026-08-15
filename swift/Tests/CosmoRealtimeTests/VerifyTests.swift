import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
@testable import CosmoRealtime

@Suite("Verify credential")
struct VerifyTests {

    private static let okBody = #"""
    {"credential":"api_key","workspace":{"name":"Acme","slug":"acme"},
     "scopes":["realtime:use"],"can_start_sessions":true,
     "realtime_voice_available":true,"external_user_id":null}
    """#

    @Test("a 200 maps to the credential's workspace, scopes, and capabilities")
    func okMapsToCredentialInfo() async throws {
        let transport = StubTransport { jsonResponse(.ok, Self.okBody) }
        let info = try await makeStubClient(transport).verify()
        #expect(info.credential == .apiKey)
        #expect(info.workspace?.slug == "acme")
        #expect(info.scopes == ["realtime:use"])
        #expect(info.canStartSessions == true)
        #expect(info.realtimeVoiceAvailable == true)
        #expect(info.externalUserId == nil)
    }

    @Test("an under-scoped credential comes back as a result, not an error")
    func underScopedCredentialIsNotAnError() async throws {
        let body = #"""
        {"credential":"user_token","workspace":null,"scopes":["chat:read"],
         "can_start_sessions":false,"realtime_voice_available":false,
         "external_user_id":"user-42"}
        """#
        let transport = StubTransport { jsonResponse(.ok, body) }
        let info = try await makeStubClient(transport).verify()
        #expect(info.credential == .userToken)
        #expect(info.canStartSessions == false)
        #expect(info.realtimeVoiceAvailable == false)
        #expect(info.externalUserId == "user-42")
        // A minted token is not told the workspace it belongs to.
        #expect(info.workspace == nil)
    }

    @Test("an auth-layer 401 maps to VerifyError.rejected carrying the detail, with no code")
    func rejectionMapsToRejected() async {
        let body = #"{"detail":"Invalid API key"}"#
        let transport = StubTransport { jsonResponse(.unauthorized, body) }
        await #expect {
            _ = try await makeStubClient(transport).verify()
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? VerifyError else { return false }
            return code == nil && detail == "Invalid API key"
        }
    }

    @Test("a 401 without `detail` never reaches the rejection path")
    func unauthorizedWithoutDetailIsTransport() async {
        // `detail` is required on the 401 schema, so the generated client
        // rejects a body without one before ``_unauthorized`` runs. That is
        // what makes its no-detail fallback unreachable today. If this ever
        // comes back ``.rejected``, the schema went optional and the fallback
        // became live text a user can see.
        let transport = StubTransport { jsonResponse(.unauthorized, "{}") }
        await #expect {
            _ = try await makeStubClient(transport).verify()
        } throws: { error in
            guard case .transport = error as? VerifyError else { return false }
            return true
        }
    }

    @Test("an undocumented rejection maps to VerifyError.rejected with the parsed code/detail")
    func undocumentedRejectionMapsToRejected() async {
        let body = #"{"detail":{"code":"workspace_forbidden","message":"no access"}}"#
        let transport = StubTransport { jsonResponse(.forbidden, body) }
        await #expect {
            _ = try await makeStubClient(transport).verify()
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? VerifyError else { return false }
            return code == "workspace_forbidden" && detail.contains("no access")
        }
    }

    @Test("a 200 with an undecodable body maps to VerifyError.invalidResponse")
    func undecodableSuccessBodyMapsToInvalidResponse() async {
        let transport = StubTransport { jsonResponse(.ok, "not json at all") }
        await #expect {
            _ = try await makeStubClient(transport).verify()
        } throws: { error in
            guard case .invalidResponse(let message) = error as? VerifyError else { return false }
            return !message.isEmpty
        }
    }

    @Test("a transport throw maps to VerifyError.transport")
    func transportThrowMapsToTransport() async {
        let transport = StubTransport { throw StubError() }
        await #expect {
            _ = try await makeStubClient(transport).verify()
        } throws: { error in
            guard case .transport(let message) = error as? VerifyError else { return false }
            return !message.isEmpty
        }
    }
}
