import LiveKit
import Testing
@testable import CosmoRealtime

/// Pins the LiveKit disconnect-type → ``RealtimeSession/EndReason``
/// classification. Deliberate server closes become ``serverEnded``; everything
/// else stays ``transportError`` — the cross-SDK mapping.
@Suite struct LiveKitDisconnectMappingTests {

    @Test("deliberate server closes map to serverEnded with the reason name")
    func serverClosesMapToServerEnded() {
        #expect(
            endReason(forDisconnectType: .roomDeleted, message: "x")
                == .serverEnded(reason: "ROOM_DELETED")
        )
        #expect(
            endReason(forDisconnectType: .participantRemoved, message: nil)
                == .serverEnded(reason: "PARTICIPANT_REMOVED")
        )
    }

    @Test("everything else stays transportError with the message as detail")
    func othersStayTransportError() {
        #expect(
            endReason(forDisconnectType: .serverShutdown, message: "shutting down")
                == .transportError(message: "shutting down")
        )
        #expect(
            endReason(forDisconnectType: .unknown, message: "??")
                == .transportError(message: "??")
        )
        #expect(
            endReason(forDisconnectType: nil, message: nil)
                == .transportError(message: "LiveKit room disconnected")
        )
    }
}
