import Foundation
import Testing

@testable import CosmoRealtime

/// The agent-track readiness signal — LiveKit's race-free "agent is live"
/// event, independent of the server `ready` data frame. The frame is a one-shot
/// broadcast the SFU never replays to a client whose data channel came up after
/// it was sent; without this fallback, a prepared-room agent that publishes
/// `ready` before the client is listening strands an otherwise-live session at
/// the 20s readiness watchdog. See the wrapper's agent-ready latch.
@Suite("RealtimeSession agent-track readiness")
struct SessionAgentLiveReadinessTests {

    @Test("transport onAgentLive yields exactly once on the agentLive stream")
    func agentLiveYieldsOnce() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())

        let collector = Task { () -> Int in
            var count = 0
            for await _ in session.agentLive { count += 1 }
            return count
        }

        // Two track-publish notifications (e.g. an agent republish) must still
        // signal readiness only once.
        await transport.signalAgentLive()
        await transport.signalAgentLive()
        await session.end()

        let count = await collector.value
        #expect(count == 1)
    }

    @Test("agentLive does not fire without a track signal")
    func agentLiveSilentWithoutSignal() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())

        let collector = Task { () -> Int in
            var count = 0
            for await _ in session.agentLive { count += 1 }
            return count
        }
        await session.end()
        #expect(await collector.value == 0)
    }
}
