import Foundation
import Testing

@testable import CosmoRealtime

/// ``MicPrewarmCoordinator/settle()`` is what lets a caller about to open the
/// input device through another engine (the note-taker's passive tap) know the
/// queued VPIO transition has actually been applied, not merely queued.
///
/// The coordinator is process-global and other suites drive it concurrently
/// (a host's session teardown queues a release), so these tests only
/// assert on their own transitions — never on the exact applied sequence.
@Suite("MicPrewarmCoordinator", .serialized)
@MainActor
struct MicPrewarmCoordinatorTests {

    @MainActor
    private final class Recorder {
        private(set) var applied: [Bool] = []
        func record(_ enabled: Bool) { applied.append(enabled) }
    }

    /// Releases *every* waiter, now and later, and stays open. The coordinator's
    /// queue is process-global, so a concurrent suite's release runs through the
    /// same swapped-in transition; a gate that hands out one wakeup strands the
    /// next caller, and one stranded transition wedges the chain — and with it
    /// every later `settle()` — for the rest of the process.
    @MainActor
    private final class Latch {
        private var isOpen = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            guard !isOpen else { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        func open() {
            guard !isOpen else { return }
            isOpen = true
            let pending = waiters
            waiters = []
            for waiter in pending { waiter.resume() }
        }
    }

    @Test("settle suspends until the queued transition has applied")
    func settleSuspendsUntilApplied() async {
        let recorder = Recorder()
        let entered = Latch()
        let release = Latch()
        let original = MicPrewarmCoordinator.transition
        defer { MicPrewarmCoordinator.transition = original }
        MicPrewarmCoordinator.transition = { enabled in
            entered.open()
            await release.wait()
            recorder.record(enabled)
        }

        MicPrewarmCoordinator.set(false)
        let appliedWhenSettled = Task { @MainActor in
            await MicPrewarmCoordinator.settle()
            return recorder.applied
        }
        // Nothing can have been applied yet: every transition is parked on
        // `release`, so the snapshot below is ordered by the latch rather than
        // by how long anything took to run.
        await entered.wait()
        release.open()

        #expect(await appliedWhenSettled.value.contains(false))
    }

    @Test("settle returns even when the transition throws")
    func settleSurvivesFailure() async {
        let original = MicPrewarmCoordinator.transition
        defer { MicPrewarmCoordinator.transition = original }
        MicPrewarmCoordinator.transition = { _ in
            throw CocoaError(.featureUnsupported)
        }

        MicPrewarmCoordinator.set(false)
        await MicPrewarmCoordinator.settle()
    }
}
