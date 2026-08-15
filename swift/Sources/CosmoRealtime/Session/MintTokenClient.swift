import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// A client for the external realtime API: start sessions, preflight the
/// credential, and read back voice-session data. Mirrors the Python
/// ``CosmoRealtime`` client. Construct once with your
/// ``RealtimeSession/Options``; reuse across calls and sessions.
///
/// Minting end-user tokens is the one capability deliberately not here: a
/// shipped device app must never mint. The server-side
/// ``mintToken(externalUserId:)`` extension ships in the opt-in
/// `CosmoRealtimeMint` product.
public struct RealtimeClient: Sendable {
    private let options: RealtimeSession.Options
    private let transport: any ClientTransport

    public init(_ options: RealtimeSession.Options) {
        self.init(options: options, transport: makeRESTTransport(options: options))
    }

    init(options: RealtimeSession.Options, transport: any ClientTransport) {
        self.options = options
        self.transport = transport
    }

    /// Start a session with this client's options — convenience over
    /// ``RealtimeSession/start(_:config:)``.
    public func start(config: SessionConfig = SessionConfig()) async throws -> RealtimeSession {
        try await RealtimeSession.start(options, config: config)
    }

    /// The generated client bound to this client's server and credential.
    package func _apiClient() -> CosmoRealtimeAPI.Client {
        CosmoRealtimeAPI.Client(
            serverURL: options.baseURL,
            transport: transport,
            middlewares: options._apiMiddlewares(prepared: nil)
        )
    }

    /// A 200 whose body failed to decode against the schema: the generated
    /// client raises a ``ClientError`` carrying the 2xx response and a
    /// ``DecodingError``. Distinguishes that from a genuine transport failure
    /// (no decoding cause).
    static func _isSuccessBodyDecodeFailure(_ error: any Error) -> Bool {
        guard
            let clientError = error as? ClientError,
            let status = clientError.response?.status.code,
            (200..<300).contains(status)
        else { return false }
        return clientError.underlyingError is DecodingError
    }

    static func _collectBody(_ payload: OpenAPIRuntime.UndocumentedPayload) async -> String {
        guard let body = payload.body else { return "" }
        return (try? await String(collecting: body, upTo: 64 * 1024)) ?? ""
    }

}

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
