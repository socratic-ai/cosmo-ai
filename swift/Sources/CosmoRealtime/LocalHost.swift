import Foundation

/// Canonical set of loopback host names. Single source of truth for
/// "is this a local-dev host" so TLS verification and analytics
/// environment detection cannot drift apart.
public enum LocalHost {
    public static let names: Set<String> = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
    ]

    public static func isLocal(_ host: String) -> Bool {
        names.contains(host.lowercased())
    }
}
