import Foundation
import LiveKit
import os.lock

/// A room created and edge-resolved before the connect that uses it, so the
/// join can begin while session start is still in flight. ``roomName`` and
/// ``roomGrant`` travel on the start request, which is what lets the backend
/// dispatch the agent into this room rather than a fresh one.
package struct PreparedRoom: Sendable {
    package let roomName: String
    package let roomGrant: String
    package let token: String
    package let livekitURL: String
    package let room: Room
    package let preparedAt: Date

    package init(
        roomName: String,
        roomGrant: String,
        token: String,
        livekitURL: String,
        room: Room,
        preparedAt: Date
    ) {
        self.roomName = roomName
        self.roomGrant = roomGrant
        self.token = token
        self.livekitURL = livekitURL
        self.room = room
        self.preparedAt = preparedAt
    }
}

/// Source of ``PreparedRoom``s for the connect path.
package protocol PreparedRoomProviding: Sendable {
    /// Hand over a room prepared for a connect with `options`, or nil when
    /// there is none, or the one held does not match this connect's backend,
    /// credential, or freshness policy. Destructive: a prepared room is handed
    /// out at most once, and a rejected one is dropped rather than kept.
    func takePreparedRoom(for options: RealtimeClient.Options) -> PreparedRoom?
}

extension RealtimeSession {

    private static let _preparedRoomProvider =
        OSAllocatedUnfairLock<(any PreparedRoomProviding)?>(initialState: nil)

    /// Install (or clear) the provider the connect path consults. No provider
    /// is installed by default, and a connect that finds none creates its room
    /// at session start.
    package static func _setPreparedRoomProvider(_ provider: (any PreparedRoomProviding)?) {
        _preparedRoomProvider.withLock { $0 = provider }
    }

    /// The installed provider's room for this connect, if any.
    static func _takePreparedRoom(for options: Options) -> PreparedRoom? {
        _preparedRoomProvider.withLock { $0 }?.takePreparedRoom(for: options)
    }
}
