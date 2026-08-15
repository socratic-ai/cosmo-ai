import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime

/// Shared constructor surface for the per-endpoint REST error enums
/// (``MintTokenError``) so the generated-client error mapping is implemented
/// once — including by the `CosmoRealtimeMint` target's mint call, hence the
/// `package` visibility here and on the helpers below.
package protocol RealtimeRESTError: Error {
    static func rejected(code: String?, detail: String) -> Self
    static func transport(message: String) -> Self
    static func invalidResponse(message: String) -> Self
}

extension MintTokenError: RealtimeRESTError {}

extension RealtimeClient {
    /// Run one generated call, splitting success-body decode failures from
    /// genuine transport failures (see ``_isSuccessBodyDecodeFailure``).
    package func _run<Output, Failure: RealtimeRESTError>(
        as _: Failure.Type,
        _ call: () async throws -> Output
    ) async throws -> Output {
        do {
            return try await call()
        } catch {
            if Self._isSuccessBodyDecodeFailure(error) {
                throw Failure.invalidResponse(message: error.localizedDescription)
            }
            throw Failure.transport(message: error.localizedDescription)
        }
    }

    package static func _undocumented<Failure: RealtimeRESTError>(
        as _: Failure.Type,
        _ statusCode: Int,
        _ payload: OpenAPIRuntime.UndocumentedPayload
    ) async -> Failure {
        let body = await _collectBody(payload)
        let detail = body.isEmpty ? "HTTP \(statusCode)" : "HTTP \(statusCode): \(body)"
        return .rejected(code: rejectionCode(inBody: body), detail: detail)
    }

    /// Map a documented auth-layer 401. Its body is ``{"detail": "..."}`` —
    /// never the error envelope — so there is no rejection code to parse.
    package static func _unauthorized<Failure: RealtimeRESTError>(
        as _: Failure.Type,
        _ detail: String?
    ) -> Failure {
        .rejected(code: nil, detail: detail ?? "HTTP 401")
    }

    package static func _rejected<Failure: RealtimeRESTError>(
        as _: Failure.Type,
        _ envelope: Components.Schemas.ErrorEnvelope?
    ) -> Failure {
        guard let envelope else {
            return .rejected(code: nil, detail: "Unprocessable content")
        }
        return .rejected(code: envelope.error.code, detail: envelope.error.message)
    }
}
