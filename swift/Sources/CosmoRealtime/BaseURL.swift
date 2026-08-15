import Foundation
import os

/// Where the SDK finds the Cosmo backend when a caller does not name one.
///
/// Reads `COSMO_BASE_URL` — the same variable the Python and TypeScript SDKs
/// read — and falls back to production. An app that pairs a stored credential
/// with the backend it was issued for (the Mac app's keychain entry) passes
/// ``RealtimeSession/Options/baseURL`` explicitly instead; a process
/// environment is not where a GUI app's backend choice lives.
public enum RealtimeBaseURL {
    public static let productionBaseURL = URL(string: "https://platform.askcosmo.ai")!
    public static let environmentVariable = "COSMO_BASE_URL"

    private static let log = Logger(
        subsystem: CosmoRealtimeLog.subsystem, category: "client"
    )

    /// A URL no ``RealtimeSession/start(_:config:micMuted:rpcHandlers:)`` will
    /// accept, so an unparseable `COSMO_BASE_URL` fails loudly at session start
    /// rather than silently opening a session against production.
    private static let unparseable = URL(string: "cosmo:invalid-base-url")!

    public static func resolve() -> URL {
        resolve(environment: ProcessInfo.processInfo.environment)
    }

    /// Resolution against a supplied environment. Internal so the public
    /// surface stays "the SDK reads `COSMO_BASE_URL`" with no URL to pass.
    static func resolve(environment: [String: String]) -> URL {
        let raw = environment[environmentVariable]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard var raw, !raw.isEmpty else { return productionBaseURL }
        // Trailing slashes are dropped so every SDK stores the same origin for
        // the same backend — and so a room prepared under one spelling still
        // matches a session started under the other.
        while raw.hasSuffix("/") { raw.removeLast() }
        guard let url = URL(string: raw) else {
            log.error("\(environmentVariable, privacy: .public) is not a URL: \(raw, privacy: .public)")
            return unparseable
        }
        return url
    }
}
