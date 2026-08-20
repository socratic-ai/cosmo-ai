import Foundation
import Testing
@testable import CosmoRealtime

/// Audio input/output level streams exposed on the new
/// ``RealtimeSession`` surface. The RMS math itself is covered by
/// ``AudioLevelTapTests``; these assert only the wiring — the
/// transport's ``inputLevels`` / ``outputLevels`` pass through to the
/// session, carry values, and finish when the transport closes. Fully
/// offline: no LiveKit server, no real audio track.
@Suite("Session audio level streams")
struct SessionLevelsTests {

    private func makeTransport() -> LiveKitSessionTransport {
        LiveKitSessionTransport(
            options: RealtimeClient.Options(
                apiKey: "test-key"
            )
        )
    }

    @Test("session passes input/output levels through from the transport")
    func sessionForwardsLevels() async throws {
        let transport = makeTransport()
        let session = RealtimeSession(transport: transport)

        async let firstInput: Float? = session.inputLevels.first { _ in true }
        async let firstOutput: Float? = session.outputLevels.first { _ in true }

        // Let the consumers start iterating before emitting (buffering
        // is newest-1, so an emit before iteration could be dropped).
        try await Task.sleep(nanoseconds: 50_000_000)
        transport._testEmitInputLevel(0.42)
        transport._testEmitOutputLevel(0.73)

        #expect(await firstInput == 0.42)
        #expect(await firstOutput == 0.73)
    }

    @Test("level streams finish when the transport closes")
    func levelsFinishOnClose() async throws {
        let transport = makeTransport()
        let session = RealtimeSession(transport: transport)

        let inputDrained = Task { for await _ in session.inputLevels {} }
        let outputDrained = Task { for await _ in session.outputLevels {} }

        await transport.close()

        // A finished stream ends its for-await loop; if the continuations
        // were not finished at close these tasks would hang and the test
        // would time out.
        await inputDrained.value
        await outputDrained.value
    }

    @Test("levels finish through the session's own teardown")
    func levelsFinishViaSessionEnd() async throws {
        let transport = makeTransport()
        let session = RealtimeSession(transport: transport)

        let inputDrained = Task { for await _ in session.inputLevels {} }

        // ``end()`` on a never-started session still runs the terminal
        // teardown, which calls ``transport.close()`` and finishes the
        // level streams.
        await session.end()

        await inputDrained.value
    }
}
