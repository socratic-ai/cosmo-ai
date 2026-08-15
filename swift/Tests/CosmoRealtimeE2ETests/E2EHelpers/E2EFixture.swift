import Foundation
import Testing

/// Configuration for an E2E test run against a local
/// ``livekit-server --dev``. Reads ``LIVEKIT_TESTING_*`` env vars
/// (matching LiveKit's own ``TestEnvironment`` convention) and
/// falls back to the local LiveKit dev server's default key/secret.
struct E2EFixture {
    let serverURL: String
    let apiKey: String
    let apiSecret: String

    /// Returns ``nil`` if the E2E server is intentionally not
    /// configured. Tests should use ``requireE2EServer()`` instead
    /// so they get a uniform skip message.
    static func loadFromEnv() -> E2EFixture? {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["LIVEKIT_TESTING_URL"], !url.isEmpty else {
            return nil
        }
        return E2EFixture(
            serverURL: url,
            apiKey: env["LIVEKIT_TESTING_API_KEY"] ?? "devkey",
            apiSecret: env["LIVEKIT_TESTING_API_SECRET"] ?? "devsecretdevsecretdevsecretdevse"
        )
    }

    /// Use at the top of every E2E test. If the env var isn't set,
    /// throws ``SkipE2E/notConfigured`` with an unambiguous skip
    /// message so the test bails out.
    static func requireE2EServer() throws -> E2EFixture {
        guard let fixture = loadFromEnv() else {
            throw SkipE2E.notConfigured
        }
        return fixture
    }

    func mintToken(
        identity: String = "e2e-tester-\(UUID().uuidString.prefix(8))",
        room: String = "e2e-room-\(UUID().uuidString.prefix(8))"
    ) throws -> (token: String, identity: String, room: String) {
        let gen = TokenGenerator(
            apiKey: apiKey,
            apiSecret: apiSecret,
            identity: identity,
            room: room
        )
        return (try gen.sign(), identity, room)
    }
}

/// Tests throw this when the E2E server isn't configured. Swift
/// Testing surfaces the throw as a test failure but the error
/// message is unambiguous about the skip reason.
enum SkipE2E: Error, CustomStringConvertible {
    case notConfigured

    var description: String {
        switch self {
        case .notConfigured:
            return "LIVEKIT_TESTING_URL not set — skipping E2E test. Start a local LiveKit server in dev mode to enable."
        }
    }
}

/// Apply at the suite level: `@Suite(.enabled(if: E2EFixture.isConfigured))`
/// so Swift Testing skips the suite cleanly when the env var isn't set,
/// rather than recording each test as failed.
extension E2EFixture {
    static var isConfigured: Bool {
        loadFromEnv() != nil
    }
}
