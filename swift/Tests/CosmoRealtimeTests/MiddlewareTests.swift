import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
@testable import CosmoRealtime

/// Verifies the two ``ClientMiddleware`` implementations in
/// ``Middlewares.swift`` correctly inject auth/origin headers and
/// transparently pass through the rest of the chain.
@Suite("Client middleware header injection")
struct MiddlewareTests {

    private static let baseURL = URL(string: "https://api.example.com")!

    private func makeRequest(
        headers: HTTPFields = HTTPFields()
    ) -> HTTPRequest {
        var req = HTTPRequest(
            method: .post,
            scheme: "https",
            authority: "api.example.com",
            path: "/v1/foo"
        )
        req.headerFields = headers
        return req
    }

    // MARK: BearerAuthMiddleware

    @Test("BearerAuthMiddleware adds Authorization header when absent")
    func bearerAddsHeader() async throws {
        let middleware = BearerAuthMiddleware(credential: .apiKey("abc123"))
        let request = makeRequest()

        var captured: HTTPRequest?
        _ = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "op"
        ) { req, _, _ in
            captured = req
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(captured?.headerFields[.authorization] == "Bearer abc123")
        #expect(
            captured?.headerFields[BearerAuthMiddleware.sdkHeaderField]
                == "\(RealtimeSession.sdkName)/\(RealtimeSession.sdkVersion)"
        )
    }

    @Test("BearerAuthMiddleware overwrites an existing Authorization header")
    func bearerOverwritesHeader() async throws {
        let middleware = BearerAuthMiddleware(credential: .apiKey("new-key"))
        var headers = HTTPFields()
        headers[.authorization] = "Bearer stale-key"
        let request = makeRequest(headers: headers)

        var captured: HTTPRequest?
        _ = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "op"
        ) { req, _, _ in
            captured = req
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(captured?.headerFields[.authorization] == "Bearer new-key")
    }

    @Test("BearerAuthMiddleware passes through body, baseURL, and does not mutate method/path")
    func bearerPassesThroughContext() async throws {
        let middleware = BearerAuthMiddleware(credential: .apiKey("abc123"))
        let request = makeRequest()
        let bodyBytes = "hello".data(using: .utf8)!
        let body: HTTPBody? = HTTPBody(bodyBytes)

        var capturedReq: HTTPRequest?
        var capturedBody: HTTPBody?
        var capturedURL: URL?

        _ = try await middleware.intercept(
            request,
            body: body,
            baseURL: Self.baseURL,
            operationID: "op-id"
        ) { req, b, url in
            capturedReq = req
            capturedBody = b
            capturedURL = url
            return (HTTPResponse(status: .ok), nil)
        }

        // baseURL is forwarded unchanged.
        #expect(capturedURL == Self.baseURL)
        // body reference is forwarded (not nil-ified or replaced).
        #expect(capturedBody != nil)
        // Other request fields are untouched.
        #expect(capturedReq?.method == .post)
        #expect(capturedReq?.path == "/v1/foo")
        #expect(capturedReq?.scheme == "https")
        #expect(capturedReq?.authority == "api.example.com")
    }

    @Test("BearerAuthMiddleware returns the response from next unchanged")
    func bearerReturnsNextResponse() async throws {
        let middleware = BearerAuthMiddleware(credential: .apiKey("abc123"))
        let request = makeRequest()
        let responseBodyBytes = "pong".data(using: .utf8)!
        let expectedBody: HTTPBody? = HTTPBody(responseBodyBytes)
        let expectedResponse = HTTPResponse(status: .init(code: 418))

        let (response, returnedBody) = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "op"
        ) { _, _, _ in
            return (expectedResponse, expectedBody)
        }

        #expect(response.status.code == 418)
        #expect(returnedBody != nil)
    }

    @Test(
        "BearerAuthMiddleware emits 'Bearer <token>' for both an api key and a minted JWT",
        arguments: [
            "wsk_live_abcdef0123456789",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.s3cr3t-sig", // gitleaks:allow — fake JWT fixture, unsigned dummy
        ]
    )
    func bearerEmitsValueForBothCredentialForms(token: String) async throws {
        for credential in [
            RealtimeSession.Options.Credential.apiKey(token), .token(token),
        ] {
            let middleware = BearerAuthMiddleware(credential: credential)
            let request = makeRequest()

            var captured: HTTPRequest?
            _ = try await middleware.intercept(
                request,
                body: nil,
                baseURL: Self.baseURL,
                operationID: "op"
            ) { req, _, _ in
                captured = req
                return (HTTPResponse(status: .ok), nil)
            }

            #expect(captured?.headerFields[.authorization] == "Bearer \(token)")
        }
    }

    @Test("BearerAuthMiddleware resolves a token-source credential's JWT per request")
    func bearerResolvesTokenSource() async throws {
        let source = TokenSource.custom {
            MintedToken(jwt: "fetched-jwt", expiresAt: Date().addingTimeInterval(3600))
        }
        let middleware = BearerAuthMiddleware(credential: .tokenSource(source))
        let request = makeRequest()

        var captured: HTTPRequest?
        _ = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "op"
        ) { req, _, _ in
            captured = req
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(captured?.headerFields[.authorization] == "Bearer fetched-jwt")
    }

    @Test("BearerAuthMiddleware surfaces a token-source fetch failure before next runs")
    func bearerPropagatesTokenSourceFailure() async throws {
        struct FetchFailed: Error, Equatable {}
        let source = TokenSource.custom { throw FetchFailed() }
        let middleware = BearerAuthMiddleware(credential: .tokenSource(source))
        let request = makeRequest()

        await #expect(throws: FetchFailed.self) {
            _ = try await middleware.intercept(
                request,
                body: nil,
                baseURL: Self.baseURL,
                operationID: "op"
            ) { _, _, _ in
                Issue.record("next must not run when the credential fetch fails")
                return (HTTPResponse(status: .ok), nil)
            }
        }
    }

    @Test("BearerAuthMiddleware writes a 'Bearer' header even with empty token (current behavior)")
    func bearerEmptyKeyStillWritesHeader() async throws {
        // Current behavior: the middleware unconditionally interpolates
        // the resolved bearer value — empty value included.
        // The ``HTTPFields`` setter trims trailing whitespace, so the
        // observed header value is ``Bearer`` (no trailing space). The
        // backend will reject the request — middleware does not
        // pre-validate.
        let middleware = BearerAuthMiddleware(credential: .apiKey(""))
        let request = makeRequest()

        var captured: HTTPRequest?
        _ = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "op"
        ) { req, _, _ in
            captured = req
            return (HTTPResponse(status: .ok), nil)
        }

        let auth = captured?.headerFields[.authorization]
        #expect(auth != nil)
        // The header IS set (not skipped), even though the key is empty.
        #expect(auth?.hasPrefix("Bearer") == true)
        // And the only payload is the keyword itself (no actual token).
        #expect(auth?.trimmingCharacters(in: .whitespaces) == "Bearer")
    }

    @Test("BearerAuthMiddleware propagates errors thrown by next")
    func bearerPropagatesNextErrors() async throws {
        struct Boom: Error, Equatable {}
        let middleware = BearerAuthMiddleware(credential: .apiKey("abc123"))
        let request = makeRequest()

        await #expect(throws: Boom.self) {
            _ = try await middleware.intercept(
                request,
                body: nil,
                baseURL: Self.baseURL,
                operationID: "op"
            ) { _, _, _ in
                throw Boom()
            }
        }
    }

    // MARK: PreparedRoomHeaderMiddleware

    @Test("PreparedRoomHeaderMiddleware injects both prepared-room headers")
    func preparedRoomAddsBothHeaders() async throws {
        let middleware = PreparedRoomHeaderMiddleware(
            roomName: "cosmo-prep", roomGrant: "grant-xyz"
        )
        let request = makeRequest()

        var captured: HTTPRequest?
        _ = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "startRealtimeSession"
        ) { req, _, _ in
            captured = req
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(captured?.headerFields[PreparedRoomHeaderMiddleware.roomNameField] == "cosmo-prep")
        #expect(captured?.headerFields[PreparedRoomHeaderMiddleware.roomGrantField] == "grant-xyz")
    }

    @Test("PreparedRoomHeaderMiddleware leaves the rest of the request untouched")
    func preparedRoomPassesThroughContext() async throws {
        let middleware = PreparedRoomHeaderMiddleware(
            roomName: "cosmo-prep", roomGrant: "grant-xyz"
        )
        var headers = HTTPFields()
        headers[.authorization] = "Bearer abc123"
        let request = makeRequest(headers: headers)

        var capturedReq: HTTPRequest?
        var capturedURL: URL?
        _ = try await middleware.intercept(
            request,
            body: nil,
            baseURL: Self.baseURL,
            operationID: "op"
        ) { req, _, url in
            capturedReq = req
            capturedURL = url
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(capturedURL == Self.baseURL)
        #expect(capturedReq?.headerFields[.authorization] == "Bearer abc123")
        #expect(capturedReq?.method == .post)
        #expect(capturedReq?.path == "/v1/foo")
    }

}
