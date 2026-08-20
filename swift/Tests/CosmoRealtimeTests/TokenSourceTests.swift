import CosmoRealtimeAPI
import Foundation
import Testing
import os.lock

@testable import CosmoRealtime

/// The refresh mechanics of ``TokenSource`` — cache reuse, the 60s skew
/// boundary, invalidation, single-flight, and failure handling — driven
/// through ``custom(_:)`` fetchers with an injected clock. The endpoint
/// constructor's HTTP round-trip is not stubbed (the suite has no
/// URLProtocol harness); its wire shape and response mapping are pinned at
/// the ``_makeEndpointRequest`` / ``_decodeEndpointResponse`` seams, the
/// same technique ``DialRequestTests`` uses for the dial call.
@Suite("TokenSource")
struct TokenSourceTests {

    private static let base = Date(timeIntervalSince1970: 1_750_000_000)

    /// A fetcher that counts its calls and returns ``jwt-<n>`` expiring
    /// ``lifetime`` after the fixed base instant.
    private final class CountingFetcher: @unchecked Sendable {
        private let count = OSAllocatedUnfairLock(initialState: 0)
        let lifetime: TimeInterval

        init(lifetime: TimeInterval = 3600) {
            self.lifetime = lifetime
        }

        var calls: Int { count.withLock { $0 } }

        func fetch() -> MintedToken {
            let n = count.withLock { $0 += 1; return $0 }
            return MintedToken(
                jwt: "jwt-\(n)", expiresAt: TokenSourceTests.base.addingTimeInterval(lifetime)
            )
        }
    }

    @Test("reuses the cached token while it has more than the skew left")
    func cacheReuse() async throws {
        let clock = OSAllocatedUnfairLock(initialState: Self.base)
        let fetcher = CountingFetcher()
        let source = TokenSource(
            fetchToken: { fetcher.fetch() },
            now: { clock.withLock { $0 } }
        )
        #expect(try await source.jwt() == "jwt-1")
        #expect(try await source.jwt() == "jwt-1")
        // 61s remaining — strictly more than the skew, still cached.
        clock.withLock { $0 = Self.base.addingTimeInterval(3600 - 61) }
        #expect(try await source.jwt() == "jwt-1")
        #expect(fetcher.calls == 1)
    }

    @Test("re-fetches at exactly the skew boundary and inside it")
    func skewRefetch() async throws {
        let clock = OSAllocatedUnfairLock(initialState: Self.base)
        let fetcher = CountingFetcher()
        let source = TokenSource(
            fetchToken: { fetcher.fetch() },
            now: { clock.withLock { $0 } }
        )
        _ = try await source.jwt()
        // Exactly 60s remaining is not "more than the skew" — fetch.
        clock.withLock { $0 = Self.base.addingTimeInterval(3600 - 60) }
        #expect(try await source.jwt() == "jwt-2")
        #expect(fetcher.calls == 2)
    }

    @Test("invalidate drops the cache so the next call re-fetches")
    func invalidateRefetches() async throws {
        let clock = OSAllocatedUnfairLock(initialState: Self.base)
        let fetcher = CountingFetcher()
        let source = TokenSource(
            fetchToken: { fetcher.fetch() },
            now: { clock.withLock { $0 } }
        )
        #expect(try await source.jwt() == "jwt-1")
        await source.invalidate()
        #expect(try await source.jwt() == "jwt-2")
        #expect(fetcher.calls == 2)
    }

    @Test("concurrent callers share one in-flight fetch")
    func singleFlight() async throws {
        let count = OSAllocatedUnfairLock(initialState: 0)
        let gate = Gate()
        let source = TokenSource.custom {
            count.withLock { $0 += 1 }
            await gate.wait()
            return MintedToken(jwt: "jwt-shared", expiresAt: Date().addingTimeInterval(3600))
        }
        let jwts = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<5 {
                group.addTask { try await source.jwt() }
            }
            group.addTask {
                while count.withLock({ $0 }) == 0 { await Task.yield() }
                await gate.open()
                return "gate-opened"
            }
            var collected: [String] = []
            for try await jwt in group { collected.append(jwt) }
            return collected
        }
        #expect(jwts.filter { $0 == "jwt-shared" }.count == 5)
        #expect(count.withLock { $0 } == 1)
    }

    @Test("a failed fetch caches nothing — the next call tries again")
    func failedFetchNotCached() async throws {
        struct FetchFailed: Error {}
        let count = OSAllocatedUnfairLock(initialState: 0)
        let source = TokenSource.custom {
            let n = count.withLock { $0 += 1; return $0 }
            if n == 1 { throw FetchFailed() }
            return MintedToken(jwt: "jwt-\(n)", expiresAt: Date().addingTimeInterval(3600))
        }
        await #expect(throws: FetchFailed.self) {
            _ = try await source.jwt()
        }
        #expect(try await source.jwt() == "jwt-2")
        #expect(count.withLock { $0 } == 2)
    }
}

/// The endpoint constructor's wire seams: the request it POSTs and the
/// response mapping onto ``MintedToken`` / ``MintTokenError``.
@Suite("TokenSource endpoint wire")
struct TokenSourceEndpointWireTests {

    private static let url = URL(string: "https://app.example.com/api/token")!

    @Test(
        "a URL that is not https (or loopback-http) is refused at construction",
        arguments: [
            "http://example.com/token",
            "ftp://localhost/token",
            "ws://localhost:8787/token",
        ]
    )
    func insecureURLRefused(urlString: String) {
        #expect {
            _ = try TokenSource.endpoint(URL(string: urlString)!)
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else {
                return false
            }
            return code == "token_source_failed" && detail.contains("https")
        }
    }

    @Test(
        "https and loopback-http URLs are accepted",
        arguments: [
            "https://app.example.com/token",
            "http://localhost:8787/token",
            "http://127.0.0.1:8787/token",
            "http://[::1]:8787/token",
        ]
    )
    func secureURLsAccepted(urlString: String) throws {
        _ = try TokenSource.endpoint(URL(string: urlString)!)
    }

    @Test("POSTs an empty JSON object body with JSON content-type")
    func requestShape() {
        let req = TokenSource._makeEndpointRequest(url: Self.url, headers: [:])
        #expect(req.httpMethod == "POST")
        #expect(req.url == Self.url)
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(req.httpBody == Data("{}".utf8))
    }

    @Test("attaches the caller's headers; the JSON content-type wins a collision")
    func requestHeaders() {
        let req = TokenSource._makeEndpointRequest(
            url: Self.url,
            headers: ["Authorization": "Bearer mint-secret", "Content-Type": "text/plain"]
        )
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer mint-secret")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    @Test("a 2xx body decodes jwt and RFC 3339 expires_at, fractional or not")
    func successDecode() throws {
        let plain = #"{"jwt":"end-user-jwt","expires_at":"2026-06-24T10:00:00Z"}"#
        let fractional = #"{"jwt":"end-user-jwt","expires_at":"2026-06-24T10:00:00.123Z"}"#
        let expected = try #require(
            ISO8601DateFormatter().date(from: "2026-06-24T10:00:00Z")
        )
        let decodedPlain = try TokenSource._decodeEndpointResponse(
            status: 200, data: Data(plain.utf8)
        )
        #expect(decodedPlain.jwt == "end-user-jwt")
        #expect(decodedPlain.expiresAt == expected)
        let decodedFractional = try TokenSource._decodeEndpointResponse(
            status: 200, data: Data(fractional.utf8)
        )
        #expect(abs(decodedFractional.expiresAt.timeIntervalSince(expected) - 0.123) < 0.001)
    }

    @Test("expiresAt — the serialized-MintedToken spelling — is accepted as the expiry")
    func aliasDecode() throws {
        let body = #"{"jwt":"j-alias","expiresAt":"2026-06-24T10:00:00.000Z"}"#
        let decoded = try TokenSource._decodeEndpointResponse(status: 200, data: Data(body.utf8))
        #expect(decoded.jwt == "j-alias")
        #expect(
            decoded.expiresAt == ISO8601DateFormatter().date(from: "2026-06-24T10:00:00Z")
        )
    }

    @Test("expires_at wins when both spellings are present")
    func canonicalExpiryWins() throws {
        let body = #"""
            {"jwt":"j","expires_at":"2026-06-24T10:00:00Z","expiresAt":"2027-01-01T00:00:00Z"}
            """#
        let decoded = try TokenSource._decodeEndpointResponse(status: 200, data: Data(body.utf8))
        #expect(
            decoded.expiresAt == ISO8601DateFormatter().date(from: "2026-06-24T10:00:00Z")
        )
    }

    @Test(
        "a 2xx body missing jwt / expires_at (or not JSON) maps to token_source_failed",
        arguments: [
            "not json at all",
            #"{"jwt":"","expires_at":"2026-06-24T10:00:00Z"}"#,
            #"{"jwt":"end-user-jwt"}"#,
            #"{"jwt":"end-user-jwt","expires_at":"tomorrow-ish"}"#,
        ]
    )
    func malformedSuccessBody(body: String) {
        #expect {
            _ = try TokenSource._decodeEndpointResponse(status: 200, data: Data(body.utf8))
        } throws: { error in
            guard case .rejected(let code, _) = error as? MintTokenError else { return false }
            return code == "token_source_failed"
        }
    }

    @Test(
        "a parseable rejection keeps the server's slug: a typed code, else the envelope's type",
        arguments: [
            (
                #"{"error":{"type":"api_error","code":"user_token_disabled","message":"Minting is disabled."}}"#,
                "user_token_disabled", "Minting is disabled."
            ),
            (
                #"{"error":{"type":"auth","message":"missing bearer"}}"#,
                "auth", "missing bearer"
            ),
            (
                #"{"error":{"type":"api_error","message":{"code":"quota_exceeded","message":"over quota"}}}"#,
                "quota_exceeded", "over quota"
            ),
            (
                #"{"detail":{"code":"version_mismatch","message":"upgrade"}}"#,
                "version_mismatch", "upgrade"
            ),
        ]
    )
    func rejectionKeepsServerSlug(body: String, expectedCode: String, expectedMessage: String) {
        #expect {
            _ = try TokenSource._decodeEndpointResponse(status: 403, data: Data(body.utf8))
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else {
                return false
            }
            return code == expectedCode && detail == expectedMessage
        }
    }

    @Test("a 30x response is refused — the exchange must not follow a redirect")
    func redirectRefused() {
        #expect {
            _ = try TokenSource._decodeEndpointResponse(
                status: 302, data: Data(), location: "http://evil.example.com/token"
            )
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else {
                return false
            }
            return code == "token_source_failed"
                && detail.contains("redirect")
                && detail.contains("http://evil.example.com/token")
        }
    }

    @Test("the redirect delegate cancels every redirect (nil replacement request)")
    func redirectDelegateReturnsNil() {
        let url = URL(string: "https://app.example.com/api/token")!
        let response = HTTPURLResponse(
            url: url, statusCode: 302, httpVersion: nil, headerFields: nil
        )!
        let replacement = OSAllocatedUnfairLock<URLRequest??>(initialState: nil)
        TokenSource.RedirectRefusingDelegate().urlSession(
            URLSession.shared,
            task: URLSession.shared.dataTask(with: url),
            willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "http://evil.example.com/token")!)
        ) { request in
            replacement.withLock { $0 = .some(request) }
        }
        #expect(replacement.withLock { $0 } == .some(nil))
    }

    @Test("an unparseable rejection maps to the synthetic http_<status>")
    func unparseableRejection() {
        #expect {
            _ = try TokenSource._decodeEndpointResponse(
                status: 500, data: Data("upstream exploded".utf8)
            )
        } throws: { error in
            guard case .rejected(let code, let detail) = error as? MintTokenError else {
                return false
            }
            return code == "http_500" && detail == "upstream exploded"
        }
    }
}

/// The session-start seam: a start rejected with HTTP 401 drops a
/// token-source credential's cache (revoked, or clocks disagree), so the
/// next start fetches fresh; any other rejection leaves it cached.
@Suite("TokenSource session start")
struct TokenSourceSessionStartTests {

    private func makeSource(_ count: OSAllocatedUnfairLock<Int>) -> TokenSource {
        TokenSource.custom {
            let n = count.withLock { $0 += 1; return $0 }
            return MintedToken(jwt: "jwt-\(n)", expiresAt: Date().addingTimeInterval(3600))
        }
    }

    private func startRejectedSession(
        credential: RealtimeClient.Options.Credential, status: Int
    ) async throws {
        let transport = FakeSessionTransport()
        await transport.scriptRejection(
            .rejected(status: status, code: nil, detail: "rejected")
        )
        let session = RealtimeSession(
            transport: transport, options: RealtimeClient.Options(credential: credential)
        )
        await #expect(throws: RealtimeSessionError.self) {
            try await session._start(config: SessionConfig())
        }
    }

    @Test("a 401 start rejection invalidates the cached token")
    func rejected401Invalidates() async throws {
        let count = OSAllocatedUnfairLock(initialState: 0)
        let source = makeSource(count)
        #expect(try await source.jwt() == "jwt-1")

        try await startRejectedSession(credential: .tokenSource(source), status: 401)

        #expect(try await source.jwt() == "jwt-2")
        #expect(count.withLock { $0 } == 2)
    }

    @Test("a non-401 start rejection leaves the cache intact")
    func rejectedNon401KeepsCache() async throws {
        let count = OSAllocatedUnfairLock(initialState: 0)
        let source = makeSource(count)
        #expect(try await source.jwt() == "jwt-1")

        try await startRejectedSession(credential: .tokenSource(source), status: 422)

        #expect(try await source.jwt() == "jwt-1")
        #expect(count.withLock { $0 } == 1)
    }

    @Test("a token-source failure during start surfaces the MintTokenError un-erased")
    func credentialFailureSurfacesMintError() async throws {
        let mintError = MintTokenError.rejected(code: "token_source_failed", detail: "fetch broke")
        let transport = FakeSessionTransport()
        await transport.scriptRejection(.credential(mintError))
        let session = RealtimeSession(
            transport: transport,
            options: RealtimeClient.Options(tokenSource: .custom { throw mintError })
        )
        await #expect(throws: mintError) {
            try await session._start(config: SessionConfig())
        }
    }

    @Test("the generated client's wrapped token-source failure is recoverable with its slug")
    func generatedClientWrapKeepsMintError() async throws {
        let mintError = MintTokenError.rejected(code: "user_token_disabled", detail: "server said no")
        let source = TokenSource.custom { throw mintError }
        let client = CosmoRealtimeAPI.Client(
            serverURL: URL(string: "https://api.example.com")!,
            transport: StubTransport { jsonResponse(.ok, "{}") },
            middlewares: RealtimeClient.Options(tokenSource: source)._apiMiddlewares(prepared: nil)
        )
        do {
            _ = try await client.verifyRealtimeCredential()
            Issue.record("the credential fetch must fail the call")
        } catch {
            #expect(LiveKitSessionTransport._mintTokenError(in: error) == mintError)
        }
    }

    @Test("_mintTokenError leaves unrelated errors alone")
    func unrelatedErrorsNotMistakenForMintError() {
        struct SomethingElse: Error {}
        #expect(LiveKitSessionTransport._mintTokenError(in: SomethingElse()) == nil)
    }
}

/// A manually opened gate: fetchers await ``wait()`` until the test calls
/// ``open()``, so concurrency tests never race on timing.
private actor Gate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        opened = true
        let parked = waiters
        waiters = []
        for waiter in parked { waiter.resume() }
    }

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
