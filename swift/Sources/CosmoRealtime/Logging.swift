import Foundation

/// Shared os_log subsystem for the CosmoRealtime SDK.
///
/// One subsystem (`socratic.cosmo-realtime`) covers everything the SDK
/// logs, so a single `log stream` / `log show` predicate captures a
/// whole session. `category` distinguishes the source (`session`,
/// `session-transport`, `session-screenshare`, `client-tools`, …).
public enum CosmoRealtimeLog {
    public static let subsystem = "socratic.cosmo-realtime"
}
