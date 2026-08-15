import Foundation
import os

/// FIFO serializer for ``RealtimeSession/setRecordingAlwaysPrepared(_:)``.
///
/// Each transition chains behind the previous one so the last caller wins:
/// the popover-open prewarm is detached, so without the chain it could land
/// after a later release and leave VPIO enabled on an idle app.
@MainActor
public enum MicPrewarmCoordinator {
    private static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "mic-prewarm")
    private static var pending: Task<Void, Never>?

    /// Applies one transition. Production drives LiveKit; tests swap in a fake
    /// to observe ordering without touching the real audio engine.
    static var transition: @MainActor (Bool) async throws -> Void = {
        try await RealtimeSession.setRecordingAlwaysPrepared($0)
    }

    public static func set(_ enabled: Bool) {
        let prior = pending
        pending = Task {
            await prior?.value
            do {
                try await transition(enabled)
            } catch {
                log.error("setRecordingAlwaysPrepared(\(enabled, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Suspend until every transition queued so far has been applied (or its
    /// failure logged). After this returns, the last requested state is in
    /// effect — the guarantee a caller needs before opening the input device
    /// through another engine.
    public static func settle() async {
        await pending?.value
    }
}
