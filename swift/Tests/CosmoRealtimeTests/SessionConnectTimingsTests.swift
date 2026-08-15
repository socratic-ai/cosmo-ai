import CosmoRealtimeAPI
import Foundation
import Testing
@testable import CosmoRealtime

/// Connect-timing surface on ``RealtimeSession``: the transport's recorder
/// passes through to the session, and the server's start-phase breakdown
/// rides the start response onto it. Fully offline: no LiveKit server, no
/// real tracks.
@Suite("Session connect timings")
struct SessionConnectTimingsTests {

    private func makeTransport() -> LiveKitSessionTransport {
        LiveKitSessionTransport(
            options: RealtimeSession.Options(
                apiKey: "test-key"
            )
        )
    }

    @Test("fresh session reports no timings")
    func freshTimingsAreEmpty() async {
        let session = RealtimeSession(transport: makeTransport())
        let t = session.connectTimings
        #expect(t.wsMs == nil)
        #expect(t.roomMs == nil)
        #expect(t.micMs == nil)
        #expect(t.totalConnectMs == nil)
        #expect(t.serverTimings == nil)
    }

    @Test("session passes the transport's connect phases through")
    func sessionForwardsConnectPhases() async {
        let transport = makeTransport()
        let session = RealtimeSession(transport: transport)

        transport.timings.setConnectPhases(wsMs: 12.5, roomMs: 300, micMs: 450, totalMs: 762.5)

        let t = session.connectTimings
        #expect(t.wsMs == 12.5)
        #expect(t.roomMs == 300)
        #expect(t.micMs == 450)
        #expect(t.totalConnectMs == 762.5)
    }

    @Test("server timings carry into the session's connect timings")
    func serverTimingsCarryThroughSession() {
        let transport = makeTransport()
        let session = RealtimeSession(transport: transport)
        transport.timings.setServerTimings(
            RealtimeSessionStartTimings(
                dbInsertMs: 40,
                dispatchMs: 60,
                mintTokensMs: 50,
                projectCheckMs: 20,
                providerResolveMs: 30,
                totalMs: 200,
                versionCheckMs: 10
            )
        )

        let timings = session.connectTimings.serverTimings
        #expect(timings?.versionCheckMs == 10)
        #expect(timings?.dispatchMs == 60)
        #expect(timings?.totalMs == 200)
    }

    @Test("serialized connect: the phases account for the whole connect")
    func serializedConnectPhasesSumToTotal() {
        // REST finishes before the join starts — the ordinary path.
        let t0 = Date()
        let phases = LiveKitSessionTransport.connectPhases(
            handshakeStart: t0,
            restDoneAt: t0.addingTimeInterval(0.100),
            joinStartedAt: t0.addingTimeInterval(0.100),
            roomConnectedAt: t0.addingTimeInterval(0.400),
            connectReadyAt: t0.addingTimeInterval(0.550),
            micMs: 150
        )
        #expect(abs(phases.wsMs - 100) < 0.01)
        #expect(abs(phases.roomMs - 300) < 0.01)
        #expect(abs(phases.totalMs - 550) < 0.01)
        // Nothing unattributed: every millisecond of the connect lands in a phase.
        #expect(abs((phases.wsMs + phases.roomMs + phases.micMs) - phases.totalMs) < 0.01)
    }

    @Test("prepared-room fast path: ws and room overlap, so they exceed the total")
    func preparedConnectPhasesOverlap() {
        // The prepared path starts the join BEFORE the REST call resolves, so
        // the two windows overlap. Documented on ``SessionConnectTimings``;
        // pinned here so the claim can't silently stop being true.
        let t0 = Date()
        let phases = LiveKitSessionTransport.connectPhases(
            handshakeStart: t0,
            restDoneAt: t0.addingTimeInterval(0.100),
            joinStartedAt: t0.addingTimeInterval(0.010),
            roomConnectedAt: t0.addingTimeInterval(0.400),
            connectReadyAt: t0.addingTimeInterval(0.400),
            micMs: 0
        )
        #expect(abs(phases.wsMs - 100) < 0.01)
        #expect(abs(phases.roomMs - 390) < 0.01)
        #expect(abs(phases.totalMs - 400) < 0.01)
        // The overlap is the point: 100 + 390 > 400.
        #expect(phases.wsMs + phases.roomMs > phases.totalMs + 1)
    }

    @Test("a started session exposes the session id and server timings")
    func startResponseIsExposed() async throws {
        let transport = FakeSessionTransport()
        await transport.setStartResponse(
            RealtimeSessionResponse(
                livekitUrl: "ws://fake.invalid",
                roomName: "room-7",
                sessionId: "session-7",
                timings: RealtimeSessionStartTimings(
                    dbInsertMs: 4,
                    dispatchMs: 6,
                    mintTokensMs: 5,
                    projectCheckMs: 2,
                    providerResolveMs: 3,
                    totalMs: 7,
                    versionCheckMs: 1
                ),
                token: "token-7"
            )
        )
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), rpcHandlers: [:])

        let timings = session.connectTimings.serverTimings
        #expect(await session.sessionId == "session-7")
        #expect(timings?.totalMs == 7)
        #expect(timings?.versionCheckMs == 1)
        // Absent on a backend predating the resolved flow, even when the
        // sibling phases are present.
        #expect(timings?.resolveMs == nil)
    }
}
