import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime

/// Developer-facing names for the generated usage-summary types.
public typealias SessionUsage = CosmoRealtimeAPI.Components.Schemas.SessionUsage
public typealias SessionTokenUsage = CosmoRealtimeAPI.Components.Schemas.SessionTokenUsage
public typealias SessionStatus = CosmoRealtimeAPI.Components.Schemas.SessionStatus
public typealias UsageStatus = CosmoRealtimeAPI.Components.Schemas.UsageStatus

/// A dedicated error type for the usage read, following ``VerifyError``.
public enum UsageError: Error, LocalizedError, Equatable {
    /// The server refused the request (HTTP ≥ 400). ``code`` is the
    /// protocol error slug when the rejection carried one.
    case rejected(code: String?, detail: String)
    /// A network or transport failure before a server verdict.
    case transport(message: String)
    /// The server replied 200 but the body could not be decoded.
    case invalidResponse(message: String)

    public var errorDescription: String? {
        switch self {
        case .rejected(let code, let detail):
            if let code { return "\(code): \(detail)" }
            return detail
        case .transport(let message):
            return "Usage transport failed: \(message)"
        case .invalidResponse(let message):
            return "Usage response decode failed: \(message)"
        }
    }
}

extension UsageError: RealtimeRESTError {}

extension RealtimeClient {
    /// Fetch a session's usage summary (GET sessions/{id}/usage):
    /// duration, talk time, and token counts in provider-reported units.
    ///
    /// Takes an explicit session id because the client outlives any one
    /// session — ``RealtimeSession/usage()`` is the id-carrying surface.
    ///
    /// Throws ``UsageError`` when the server rejects the request, the
    /// transport fails, or the response body cannot be decoded.
    public func sessionUsage(sessionId: String) async throws -> SessionUsage {
        let output = try await _run(as: UsageError.self) {
            try await _apiClient().getSessionUsage(path: .init(sessionId: sessionId))
        }
        switch output {
        case .ok(let ok):
            return try ok.body.json
        case .unauthorized(let err):
            throw Self._unauthorized(as: UsageError.self, try? err.body.json.detail)
        case .unprocessableContent(let err):
            throw Self._rejected(as: UsageError.self, try? err.body.json)
        case .undocumented(let statusCode, let payload):
            throw await Self._undocumented(as: UsageError.self, statusCode, payload)
        }
    }
}

extension RealtimeSession {
    /// Fetch this session's usage summary: duration, talk time, and token
    /// counts in provider-reported units.
    ///
    /// An authenticated REST read, not a data-channel frame — callable while
    /// the session is live and, unlike the sends, after it ends. The
    /// detailed summary is written shortly after the session ends;
    /// ``SessionUsage/usageStatus`` on the result reports whether it
    /// is present yet.
    ///
    /// Throws ``UsageError`` on a server rejection or transport failure, and
    /// ``RealtimeSessionError/notConnected`` if the session never started.
    public func usage() async throws -> SessionUsage {
        guard let options, let sessionId else {
            throw RealtimeSessionError.notConnected
        }
        let client = restClient ?? RealtimeClient(options)
        restClient = client
        return try await client.sessionUsage(sessionId: sessionId)
    }
}
