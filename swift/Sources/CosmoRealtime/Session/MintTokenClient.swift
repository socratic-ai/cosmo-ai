import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// A short-lived per-user JWT — minted server-side (the `CosmoRealtimeMint`
/// product's `mintToken(externalUserId:)`) or fetched by a ``TokenSource``.
public struct MintedToken: Sendable, Equatable {
    public let jwt: String
    public let expiresAt: Date
    /// Server-side revocation handle (``DELETE auth/token/{token_id}``) —
    /// keep it on your server; the device only needs ``jwt``. Cosmo always
    /// returns it; it is optional here because this type doubles as the
    /// ``TokenSource`` cached shape, whose contract is any backend
    /// returning ``{ jwt, expires_at }``.
    public let tokenId: String?

    public init(jwt: String, expiresAt: Date, tokenId: String? = nil) {
        self.jwt = jwt
        self.expiresAt = expiresAt
        self.tokenId = tokenId
    }
}

/// A dedicated error type for the mint call and for ``TokenSource``
/// fetches, mirroring the Python SDK's ``MintTokenError``.
public enum MintTokenError: Error, LocalizedError, Equatable {
    /// The server refused the request (HTTP ≥ 400). ``code`` is the protocol
    /// error slug when the rejection carried one.
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
            return "Mint token transport failed: \(message)"
        case .invalidResponse(let message):
            return "Mint token response decode failed: \(message)"
        }
    }
}
