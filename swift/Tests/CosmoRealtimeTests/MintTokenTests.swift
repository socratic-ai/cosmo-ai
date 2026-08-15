import CosmoRealtimeMint
import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
import os.lock
@testable import CosmoRealtime

@Suite("Mint token")
struct MintTokenTests {


    @Test("a 200 maps to a MintedToken with the parsed jwt and expiry")
    func okMapsToMintedToken() async throws {
        let body = #"{"jwt":"end-user-jwt","expires_at":"2026-06-24T10:00:00Z","token_id":"tok-1"}"#
        let transport = StubTransport {
            (HTTPResponse(status: .ok), HTTPBody(body))
        }
        let token = try await makeStubClient(transport).mintToken(externalUserId: "user-42")
        #expect(token.jwt == "end-user-jwt")
        var components = DateComponents()
        components.year = 2026
        components.month = 6
        components.day = 24
        components.hour = 10
        components.timeZone = TimeZone(identifier: "UTC")
        let expected = Calendar(identifier: .gregorian).date(from: components)
        #expect(token.expiresAt == expected)
        #expect(token.tokenId == "tok-1")
    }

    @Test("an auth-layer 401 maps to MintTokenError.rejected carrying the detail, with no code")
    func unauthorizedMapsToRejected() async {
        let body = #"{"detail":"Invalid API key"}"#
        let transport = StubTransport { jsonResponse(.unauthorized, body) }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "user-42")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else { return false }
            return code == nil && detail == "Invalid API key"
        }
    }

    @Test("an undocumented 4xx maps to MintTokenError.rejected with the parsed code/detail")
    func undocumentedRejectionMapsToRejected() async {
        let body = #"{"detail":{"code":"forbidden","message":"missing scope"}}"#
        let transport = StubTransport { jsonResponse(.forbidden, body) }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "user-42")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else { return false }
            return code == "forbidden" && detail.contains("missing scope")
        }
    }

    @Test("an undocumented rejection without a detail.code maps to .rejected(code: nil, …)")
    func undocumentedRejectionWithoutCodeMapsToNilCode() async {
        let body = #"{"detail":"service unavailable"}"#
        let transport = StubTransport { jsonResponse(.serviceUnavailable, body) }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "user-42")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else { return false }
            // No object-shaped detail.code, so no protocol code is extracted;
            // the detail still carries the status and raw body.
            return code == nil && detail.contains("503") && detail.contains("service unavailable")
        }
    }

    @Test("a documented 422 maps to MintTokenError.rejected with the envelope's code and message")
    func unprocessableContentMapsToRejected() async {
        let body = #"{"error":{"type":"validation_error","message":"Invalid request parameters \u2014 body.external_user_id: Field required","errors":[{"loc":["body","external_user_id"],"type":"missing","msg":"Field required"}]}}"#
        let transport = StubTransport { jsonResponse(.unprocessableContent, body) }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else { return false }
            // Validation rejections carry no protocol code; the message names
            // the failing field.
            return code == nil && detail.contains("Field required")
        }
    }

    @Test("a typed 422 rejection surfaces the envelope's error code")
    func typedRejectionSurfacesCode() async {
        let body = #"{"error":{"type":"api_error","code":"inline_tools_not_allowed","message":"Inline server-tool definitions require API-key authentication."}}"#
        let transport = StubTransport { jsonResponse(.unprocessableContent, body) }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "")
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else { return false }
            return code == "inline_tools_not_allowed" && detail.contains("API-key")
        }
    }

    @Test("a 200 with an undecodable body maps to MintTokenError.invalidResponse")
    func undecodableSuccessBodyMapsToInvalidResponse() async {
        let transport = StubTransport { jsonResponse(.ok, "not json at all") }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "user-42")
        } throws: { error in
            guard case .invalidResponse(let message) = error as? MintTokenError else { return false }
            return !message.isEmpty
        }
    }

    @Test("a transport throw maps to MintTokenError.transport")
    func transportThrowMapsToTransport() async {
        let transport = StubTransport { throw StubError() }
        await #expect {
            _ = try await makeStubClient(transport).mintToken(externalUserId: "user-42")
        } throws: { error in
            guard case .transport(let message) = error as? MintTokenError else { return false }
            return !message.isEmpty
        }
    }
}
