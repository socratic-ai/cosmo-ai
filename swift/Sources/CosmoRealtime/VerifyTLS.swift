import Foundation

public enum VerifyTLS: Sendable, Equatable {
    /// Verify for remote hosts, skip for loopback (self-signed local dev). Default.
    case auto
    /// Always verify, including loopback.
    case enabled
    /// Never verify, for any host. A deliberate escape hatch — it weakens trust
    /// for remote hosts too, not just loopback.
    case disabled

    public func resolve(forHost host: String) -> Bool {
        switch self {
        case .enabled:  return true
        case .disabled: return false
        case .auto:     return !LocalHost.isLocal(host)
        }
    }
}
