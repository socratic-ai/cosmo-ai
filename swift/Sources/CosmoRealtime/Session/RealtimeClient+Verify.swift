import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime

/// Developer-facing names for the generated credential-preflight types.
public typealias CredentialInfo = CosmoRealtimeAPI.Components.Schemas.VerifyResponse
public typealias WorkspaceInfo = CosmoRealtimeAPI.Components.Schemas.WorkspaceInfo
public typealias CredentialKind = CosmoRealtimeAPI.Components.Schemas.CredentialKind

/// A dedicated error type for ``RealtimeClient/verify()``, following
/// ``MintTokenError``. An under-scoped credential is not an error here — it
/// comes back as ``CredentialInfo/canStartSessions`` being false.
public enum VerifyError: Error, LocalizedError, Equatable {
    /// The server refused the credential (HTTP ≥ 400). ``code`` is the
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
            return "Verify transport failed: \(message)"
        case .invalidResponse(let message):
            return "Verify response decode failed: \(message)"
        }
    }
}

extension VerifyError: RealtimeRESTError {}

extension RealtimeClient {
    /// Check this client's credential without starting a session (GET
    /// realtime/verify).
    ///
    /// A free preflight for a launch-time check or a CI smoke test: it
    /// confirms the credential authenticates against ``RealtimeClient/Options/baseURL``,
    /// and the result separates the failure modes a first session would
    /// otherwise conflate — under-scoped (``CredentialInfo/canStartSessions``)
    /// versus a deployment with no default voice stack configured
    /// (``CredentialInfo/realtimeVoiceAvailable``).
    ///
    /// Throws ``VerifyError`` when the server rejects the credential, the
    /// transport fails, or the response body cannot be decoded.
    public func verify() async throws -> CredentialInfo {
        let output = try await _run(as: VerifyError.self) {
            try await _apiClient().verifyRealtimeCredential()
        }
        switch output {
        case .ok(let ok):
            return try ok.body.json
        case .unauthorized(let err):
            throw Self._unauthorized(as: VerifyError.self, try? err.body.json.detail)
        case .undocumented(let statusCode, let payload):
            throw await Self._undocumented(as: VerifyError.self, statusCode, payload)
        }
    }
}
