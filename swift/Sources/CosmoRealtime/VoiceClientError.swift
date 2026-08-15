import Foundation

@frozen public enum VoiceClientError: Error, Sendable {
    case notConnected
    case invalidURL(reason: String)
    case handshakeFailed(status: Int, body: String?)
    case voiceDisabled
    case closedByServer(code: Int, reason: String?)
    case transport(underlying: any Error & Sendable)
    case decode(underlying: DecodingError)
    case micPermissionDenied
    case audioEngineFailed(message: String)
}
