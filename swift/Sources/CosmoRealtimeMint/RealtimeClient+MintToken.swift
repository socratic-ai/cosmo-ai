import CosmoRealtime
import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime

/// `CosmoRealtimeMint` — the server-side mint capability, split out of
/// `CosmoRealtime` on purpose: minting requires a workspace API key, and a
/// shipped device app must never hold one. A backend (a token endpoint, a
/// CLI, a provisioning job) adds this product and gains
/// ``CosmoRealtime/RealtimeClient/mintToken(externalUserId:)`` on the same
/// ``CosmoRealtime/RealtimeClient`` type; a plain `import CosmoRealtime`
/// consumer never sees it.
extension RealtimeClient {
    /// Mint a short-lived per-user JWT for `externalUserId` (POST auth/token).
    /// Run this server-side with an api-key credential; hand the returned
    /// ``MintedToken/jwt`` to the end user's device, which constructs
    /// ``RealtimeClient/Options`` and starts a session. Idempotent per
    /// `(workspace, externalUserId)` — the same external user maps to the same
    /// auto-provisioned project on repeat calls. `ttlSeconds` (60–86400)
    /// shortens the 24-hour default lifetime.
    ///
    /// Throws ``MintTokenError`` if the server rejects the request, the
    /// transport fails, or the response body cannot be decoded.
    public func mintToken(
        externalUserId: String, ttlSeconds: Int? = nil
    ) async throws -> MintedToken {
        let output = try await _run(as: MintTokenError.self) {
            try await _mint(externalUserId: externalUserId, ttlSeconds: ttlSeconds)
        }
        switch output {
        case .ok(let ok):
            let response = try ok.body.json
            return MintedToken(
                jwt: response.jwt,
                expiresAt: response.expiresAt,
                tokenId: response.tokenId
            )
        case .unauthorized(let err):
            throw Self._unauthorized(as: MintTokenError.self, try? err.body.json.detail)
        case .unprocessableContent(let err):
            throw Self._rejected(as: MintTokenError.self, try? err.body.json)
        case .undocumented(let statusCode, let payload):
            throw await Self._undocumented(as: MintTokenError.self, statusCode, payload)
        }
    }

    /// The single generated mint call. Isolated so an operationId cleanup that
    /// renames the method is a one-line change.
    private func _mint(
        externalUserId: String, ttlSeconds: Int?
    ) async throws -> CosmoRealtimeAPI.Operations.MintProjectToken.Output {
        try await _apiClient().mintProjectToken(
            body: .json(.init(externalUserId: externalUserId, ttlSeconds: ttlSeconds))
        )
    }
}
