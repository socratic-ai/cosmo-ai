import Foundation
import Testing

@testable import CosmoRealtime

/// ``waitUntilEnded()`` and ``waitUntilAgentLive()`` exist so a consumer never
/// has to hand-roll a task around ``events`` plus a watchdog and race the two.
/// Both must be safe to call at any point in the lifecycle, including after the
/// thing they wait for already happened, and neither may outlive the session.
@Suite("RealtimeSession wait helpers")
struct SessionWaitTests {

    @Test("waitUntilEnded returns once the session ends")
    func waitUntilEndedResumes() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())

        let waiter = Task { await session.waitUntilEnded() }
        await session.end()
        await waiter.value
    }

    @Test("waitUntilEnded returns immediately on an already-ended session")
    func waitUntilEndedAfterClose() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())
        await session.end()

        await session.waitUntilEnded()
    }

    @Test("every waiter is resumed, not just the first")
    func waitUntilEndedResumesAllWaiters() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())

        let waiters = (0..<3).map { _ in Task { await session.waitUntilEnded() } }
        await session.end()
        for waiter in waiters { await waiter.value }
    }

    /// The whole point of the liveness signal: a session whose agent never
    /// shows up must still release the waiter at teardown rather than parking
    /// it forever — the exact hang the broadcast-`ready` race produced.
    @Test("waitUntilAgentLive returns when the session ends without an agent")
    func waitUntilAgentLiveReleasedByClose() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())

        let waiter = Task { await session.waitUntilAgentLive() }
        await session.end()
        await waiter.value
    }
}
