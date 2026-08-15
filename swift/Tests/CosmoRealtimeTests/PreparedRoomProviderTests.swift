import Foundation
import LiveKit
import Testing

@testable import CosmoRealtime

/// The seam the connect path consults for a pre-created room. No provider is
/// installed by default, which is the whole behavior of the published SDK:
/// every connect creates its room at session start. Serialized because the
/// installed provider is process-global.
@Suite("PreparedRoomProviding seam", .serialized)
struct PreparedRoomProviderTests {

    private struct StubProvider: PreparedRoomProviding {
        let room: PreparedRoom
        func takePreparedRoom(for options: RealtimeSession.Options) -> PreparedRoom? { room }
    }

    private static func makeOptions() -> RealtimeSession.Options {
        RealtimeSession.Options(
            credential: .apiKey("key"), baseURL: URL(string: "https://api.example.com")!
        )
    }

    private static func makeRoom() -> PreparedRoom {
        PreparedRoom(
            roomName: "cosmo-prep",
            roomGrant: "grant",
            token: "tok",
            livekitURL: "wss://a.example",
            room: Room(),
            preparedAt: Date()
        )
    }

    init() {
        RealtimeSession._setPreparedRoomProvider(nil)
    }

    @Test func noProviderInstalledYieldsNoPreparedRoom() {
        #expect(RealtimeSession._takePreparedRoom(for: Self.makeOptions()) == nil)
    }

    @Test func installedProviderSuppliesItsRoom() throws {
        defer { RealtimeSession._setPreparedRoomProvider(nil) }
        let room = Self.makeRoom()
        RealtimeSession._setPreparedRoomProvider(StubProvider(room: room))
        let taken = try #require(RealtimeSession._takePreparedRoom(for: Self.makeOptions()))
        #expect(taken.roomName == room.roomName)
        #expect(taken.room === room.room)
    }

    @Test func clearingTheProviderRestoresTheSerializedPath() {
        RealtimeSession._setPreparedRoomProvider(StubProvider(room: Self.makeRoom()))
        RealtimeSession._setPreparedRoomProvider(nil)
        #expect(RealtimeSession._takePreparedRoom(for: Self.makeOptions()) == nil)
    }
}
