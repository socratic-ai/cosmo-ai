import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Injects ``Authorization: Bearer <token>`` and the SDK identity header on
/// every outbound request. The bearer value is a workspace api key, a minted
/// per-user JWT, or a source-fetched JWT — indistinguishable on the wire.
/// Resolved per request so a ``TokenSource`` credential can refresh between
/// calls.
struct BearerAuthMiddleware: ClientMiddleware {
    static let sdkHeaderField = HTTPField.Name("x-cosmo-sdk")!

    let credential: RealtimeSession.Options.Credential

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var req = request
        req.headerFields[.authorization] = "Bearer \(try await credential.bearerToken())"
        req.headerFields[Self.sdkHeaderField] = RealtimeSession.sdkIdentityHeaderValue
        return try await next(req, body, baseURL)
    }
}

/// Names the room a session start should be dispatched into, when the client
/// created one ahead of the start. Sent as headers because the session-config
/// request body describes the agent and the run, not the room the caller
/// already holds; the backend folds the ref back into the typed request.
struct PreparedRoomHeaderMiddleware: ClientMiddleware {
    static let roomNameField = HTTPField.Name("x-cosmo-prepared-room-name")!
    static let roomGrantField = HTTPField.Name("x-cosmo-prepared-room-grant")!

    let roomName: String
    let roomGrant: String

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var req = request
        req.headerFields[Self.roomNameField] = roomName
        req.headerFields[Self.roomGrantField] = roomGrant
        return try await next(req, body, baseURL)
    }
}
