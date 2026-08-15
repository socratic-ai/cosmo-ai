import Foundation
import Testing
@testable import CosmoRealtime

/// The impure layer of zero-argument credential resolution: path selection,
/// file reading, and what the resolving ``RealtimeSession/Options`` init does
/// with the result. Chain semantics are pinned by the shared vectors
/// (``CredentialsResolutionConformanceTests``).
@Suite struct CredentialsFileTests {
    private static let validFile = """
        version = 1

        [default]
        slug = "acme"
        api_key = "cosmo_file_key"
        api_key_id = "key-1"
        base_url = "https://app.askcosmo.ai"
        expires_at = "2099-01-01T00:00:00Z"
        """

    private func withTemporaryFile<T>(
        _ content: String?, _ body: (String) throws -> T
    ) throws -> T {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cosmo-creds-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("credentials").path
        if let content {
            try content.write(toFile: path, atomically: true, encoding: .utf8)
        }
        return try body(path)
    }

    @Test func optionsInitAdoptsFileCredentialAndBaseURL() throws {
        try withTemporaryFile(Self.validFile) { path in
            let options = try RealtimeSession.Options(
                environment: ["COSMO_CREDENTIALS_FILE": path]
            )
            #expect(options.credential == .apiKey("cosmo_file_key"))
            #expect(options.baseURL == URL(string: "https://app.askcosmo.ai")!)
            #expect(options.canMint)
        }
    }

    @Test func optionsInitPrefersEnvKeyAndKeepsDefaultBase() throws {
        try withTemporaryFile(Self.validFile) { path in
            let options = try RealtimeSession.Options(
                environment: [
                    "COSMO_CREDENTIALS_FILE": path,
                    "COSMO_API_KEY": "cosmo_env_key",
                ]
            )
            #expect(options.credential == .apiKey("cosmo_env_key"))
            #expect(options.baseURL == RealtimeBaseURL.productionBaseURL)
        }
    }

    @Test func optionsInitConflictingEnvBaseURLIsRefused() throws {
        try withTemporaryFile(Self.validFile) { path in
            do {
                _ = try RealtimeSession.Options(
                    environment: [
                        "COSMO_CREDENTIALS_FILE": path,
                        "COSMO_BASE_URL": "http://localhost:8123",
                    ]
                )
                Issue.record("expected CredentialsError.baseURLMismatch")
            } catch let error as CredentialsError {
                #expect(error.code == "base_url_mismatch")
                let message = error.errorDescription ?? ""
                #expect(message.contains("http://localhost:8123"))
                #expect(message.contains("https://app.askcosmo.ai"))
            }
        }
    }

    @Test func optionsInitMatchingEnvBaseURLResolves() throws {
        try withTemporaryFile(Self.validFile) { path in
            let options = try RealtimeSession.Options(
                environment: [
                    "COSMO_CREDENTIALS_FILE": path,
                    "COSMO_BASE_URL": "https://app.askcosmo.ai/",
                ]
            )
            #expect(options.baseURL == URL(string: "https://app.askcosmo.ai")!)
        }
    }

    @Test func optionsInitWithNothingToResolveThrowsNotFound() throws {
        try withTemporaryFile(nil) { path in
            #expect(throws: CredentialsError.self) {
                _ = try RealtimeSession.Options(
                    environment: ["COSMO_CREDENTIALS_FILE": path]
                )
            }
            do {
                _ = try RealtimeSession.Options(
                    environment: ["COSMO_CREDENTIALS_FILE": path]
                )
            } catch let error as CredentialsError {
                #expect(error.code == "no_credential")
                let message = error.errorDescription ?? ""
                #expect(message.contains("COSMO_API_KEY"))
                #expect(message.contains("cosmo login"))
                #expect(message.contains(path))
            }
        }
    }

    @Test func optionsInitWithExpiredKeyThrowsExpired() throws {
        let expired = Self.validFile.replacingOccurrences(
            of: "2099-01-01T00:00:00Z", with: "2020-01-01T00:00:00Z"
        )
        try withTemporaryFile(expired) { path in
            do {
                _ = try RealtimeSession.Options(
                    environment: ["COSMO_CREDENTIALS_FILE": path]
                )
                Issue.record("expected CredentialsError.expired")
            } catch let error as CredentialsError {
                #expect(error.code == "expired")
                #expect((error.errorDescription ?? "").contains("cosmo login"))
            }
        }
    }

    @Test func defaultPathIsHomeDotCosmo() {
        let path = CredentialsFile.resolvePath(environment: [:])
        #expect(path.hasSuffix("/.cosmo/credentials"))
    }

    @Test func explicitCredentialInitsAreUntouchedByEnvironment() {
        let options = RealtimeSession.Options(apiKey: "cosmo_explicit")
        #expect(options.credential == .apiKey("cosmo_explicit"))
    }
}
