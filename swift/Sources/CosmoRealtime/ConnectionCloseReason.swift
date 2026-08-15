import Foundation

@frozen public enum ConnectionCloseReason: Sendable, Equatable {
    case clientEnded
    case clientClosed
    case pingTimeout
    case voiceDisabled
    case serverClosed(code: Int, reason: String?)
    case transportError(message: String)
    /// The transport joined but no agent published a track within the readiness
    /// window. Distinct from ``transportError`` (a genuine transport-join
    /// failure) because the recovery differs: a slow/failed agent must not be
    /// retried the way a network blip is — retrying restarts agent dispatch and
    /// can leave two agents in the room.
    case agentNotReady(afterSeconds: Int)
    case decodeError(message: String)
    case handshakeFailed(status: Int)
}
