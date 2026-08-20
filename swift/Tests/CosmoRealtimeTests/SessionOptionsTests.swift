import Foundation
import Testing
@testable import CosmoRealtime

@Suite("RealtimeClient.Options credential surface")
struct SessionOptionsTests {

    private static let baseURL = URL(string: "https://platform.askcosmo.ai")!

    @Test("init(apiKey:) yields an apiKey credential that can mint")
    func apiKeyCredential() {
        let options = RealtimeClient.Options(apiKey: "k")
        #expect(options.credential == .apiKey("k"))
        #expect(options.canMint == true)
    }

    @Test("init(token:) yields a token credential that cannot mint")
    func tokenCredential() {
        let options = RealtimeClient.Options(token: "jwt")
        #expect(options.credential == .token("jwt"))
        #expect(options.canMint == false)
    }

    @Test("designated init(credential:) preserves an apiKey credential that can mint")
    func designatedInitApiKey() {
        let options = RealtimeClient.Options(credential: .apiKey("k"))
        #expect(options.credential == .apiKey("k"))
        #expect(options.canMint == true)
    }

    @Test("designated init(credential:) preserves a token credential that cannot mint")
    func designatedInitToken() {
        let options = RealtimeClient.Options(credential: .token("jwt"))
        #expect(options.credential == .token("jwt"))
        #expect(options.canMint == false)
    }

    @Test("options take their backend from the resolver, not the caller")
    func baseURLComesFromResolver() {
        #expect(RealtimeClient.Options(apiKey: "k").baseURL == RealtimeBaseURL.resolve())
    }

    @Test("init(tokenSource:) yields a tokenSource credential that cannot mint")
    func tokenSourceCredential() {
        let source = TokenSource.custom {
            MintedToken(jwt: "jwt", expiresAt: Date().addingTimeInterval(3600))
        }
        let options = RealtimeClient.Options(tokenSource: source)
        #expect(options.credential == .tokenSource(source))
        #expect(options.canMint == false)
    }

    @Test("bearerToken returns the underlying secret for each case")
    func bearerTokenUnwraps() async throws {
        #expect(try await RealtimeClient.Options.Credential.apiKey("k").bearerToken() == "k")
        #expect(try await RealtimeClient.Options.Credential.token("jwt").bearerToken() == "jwt")
        let source = TokenSource.custom {
            MintedToken(jwt: "fetched-jwt", expiresAt: Date().addingTimeInterval(3600))
        }
        #expect(
            try await RealtimeClient.Options.Credential.tokenSource(source).bearerToken()
                == "fetched-jwt"
        )
    }

    @Test("tokenSource credentials are equal by source identity, not configuration")
    func tokenSourceEquality() {
        let fetch: @Sendable () async throws -> MintedToken = {
            MintedToken(jwt: "jwt", expiresAt: Date().addingTimeInterval(3600))
        }
        let source = TokenSource.custom(fetch)
        let other = TokenSource.custom(fetch)
        #expect(
            RealtimeClient.Options.Credential.tokenSource(source) == .tokenSource(source)
        )
        #expect(
            RealtimeClient.Options.Credential.tokenSource(source) != .tokenSource(other)
        )
        #expect(RealtimeClient.Options.Credential.tokenSource(source) != .token("jwt"))
    }

    @Test("description and debugDescription mask the secret")
    func credentialMasksSecret() {
        let key = RealtimeClient.Options.Credential.apiKey("super-secret-key")
        let token = RealtimeClient.Options.Credential.token("super-secret-jwt")
        let source = RealtimeClient.Options.Credential.tokenSource(
            .custom { MintedToken(jwt: "jwt", expiresAt: Date()) }
        )

        for rendered in [key.description, key.debugDescription] {
            #expect(!rendered.contains("super-secret-key"))
            #expect(rendered == "Credential.apiKey(•••)")
        }
        for rendered in [token.description, token.debugDescription] {
            #expect(!rendered.contains("super-secret-jwt"))
            #expect(rendered == "Credential.token(•••)")
        }
        for rendered in [source.description, source.debugDescription] {
            #expect(rendered == "Credential.tokenSource(•••)")
        }
    }

    @Test(
        "isSecureBaseURL allows https and loopback http, rejects cleartext to a remote host",
        arguments: [
            ("https://platform.askcosmo.ai", true),
            ("https://EXAMPLE.com", true),
            ("http://localhost:8000", true),
            ("http://LOCALHOST", true),
            ("http://LocalHost:8000", true),
            ("http://127.0.0.1", true),
            ("http://[::1]:8000", true),
            ("http://example.com", false),
            // Host-less URL: `.host` is nil, so it fails closed as insecure.
            ("http:///path", false),
        ]
    )
    func secureBaseURLClassification(urlString: String, expected: Bool) {
        let url = URL(string: urlString)!
        #expect(RealtimeSession.isSecureBaseURL(url) == expected)
    }

    @Test(
        "VerifyTLS.resolve: .auto verifies remote hosts and skips loopback only; .enabled/.disabled are unconditional",
        arguments: [
            (VerifyTLS.auto, "platform.askcosmo.ai", true),
            (VerifyTLS.auto, "localhost", false),
            (VerifyTLS.auto, "LOCALHOST", false),
            (VerifyTLS.auto, "127.0.0.1", false),
            (VerifyTLS.auto, "::1", false),
            // Look-alikes are not loopback — must still verify.
            (VerifyTLS.auto, "localhost.evil.com", true),
            (VerifyTLS.auto, "127.0.0.1.evil.com", true),
            // Empty host (URL.host nil → "") fails closed: verify.
            (VerifyTLS.auto, "", true),
            // .enabled always verifies; .disabled is a global escape hatch that
            // weakens trust even for a remote host.
            (VerifyTLS.enabled, "localhost", true),
            (VerifyTLS.disabled, "platform.askcosmo.ai", false),
        ]
    )
    func verifyTLSResolution(mode: VerifyTLS, host: String, expectVerify: Bool) {
        #expect(mode.resolve(forHost: host) == expectVerify)
    }

    @Test("start rejects a cleartext remote base URL before any network call")
    func startThrowsOnInsecureBaseURL() async {
        let options = RealtimeClient.Options(
            apiKey: "k", baseURL: URL(string: "http://example.com")!
        )
        await #expect(throws: RealtimeSessionError.insecureBaseURL("http://example.com")) {
            _ = try await RealtimeSession.start(options)
        }
    }
}

@Suite("COSMO_BASE_URL resolution")
struct BaseURLResolutionTests {

    private func resolve(_ value: String?) -> URL {
        RealtimeBaseURL.resolve(environment: value.map { ["COSMO_BASE_URL": $0] } ?? [:])
    }

    @Test("an unset, empty, or whitespace-only value falls back to production")
    func fallsBackToProduction() {
        for value in [nil, "", "   "] {
            #expect(resolve(value) == RealtimeBaseURL.productionBaseURL)
        }
    }

    @Test("a configured backend is used verbatim, trimmed")
    func usesConfiguredBackend() {
        #expect(resolve("  https://staging.example.com  ")
            == URL(string: "https://staging.example.com")!)
    }

    @Test("trailing slashes are dropped so one backend has one spelling")
    func dropsTrailingSlashes() {
        #expect(resolve("https://staging.example.com///")
            == URL(string: "https://staging.example.com")!)
    }

    @Test("a cleartext remote backend resolves to something start will reject")
    func cleartextRemoteIsRejectable() {
        #expect(RealtimeSession.isSecureBaseURL(resolve("http://evil.example.com")) == false)
        #expect(RealtimeSession.isSecureBaseURL(resolve("http://localhost:8000")) == true)
    }

    @Test("an unparseable value never silently resolves to production")
    func unparseableIsNotProduction() {
        let resolved = resolve("not a url")
        #expect(resolved != RealtimeBaseURL.productionBaseURL)
        #expect(RealtimeSession.isSecureBaseURL(resolved) == false)
    }
}
