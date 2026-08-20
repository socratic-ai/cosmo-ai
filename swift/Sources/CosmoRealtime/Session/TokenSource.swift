import Foundation
import os

/// A credential that fetches — and keeps fresh — a minted end-user token.
///
/// A shipped app must not hold an API key, and a static minted JWT expires
/// after 24 hours. A ``TokenSource`` closes the gap: it knows how to fetch a
/// fresh ``MintedToken`` from the developer's own backend, caches it in
/// memory, and re-fetches when the cached token nears expiry — so options
/// built with ``RealtimeClient/Options/init(tokenSource:baseURL:connectTimeout:requestTimeout:verifyTLS:)``
/// stay valid for the life of the process with no refresh code in the app.
///
/// The session asks the source for a JWT whenever a request needs auth; the
/// source reuses its cached token while comfortably within its lifetime and
/// re-fetches otherwise. A session start rejected with HTTP 401 drops the
/// cache, so the next start fetches fresh.
///
/// Two constructors:
///
/// - ``endpoint(_:headers:)`` — POST a token endpoint that returns
///   ``{ jwt, expires_at }`` (the shape mint responses already have; any
///   backend that forwards ``POST auth/token`` qualifies).
/// - ``custom(_:)`` — any async function returning a ``MintedToken`` — full
///   control over transport and auth.
public final class TokenSource: Sendable {

    static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "token-source")

    /// Re-fetch this long before ``MintedToken/expiresAt`` so an in-flight
    /// session start never races the expiry boundary. Matches the cross-SDK
    /// contract (``token-source-vectors.json``).
    static let refreshSkew: TimeInterval = 60

    /// The error slug for failures detected on this side of the wire —
    /// transport, a non-JSON body, a missing ``jwt`` / ``expires_at``. A
    /// parseable server rejection keeps the server's slug instead.
    static let failedCode = "token_source_failed"

    private let store: Store

    init(
        fetchToken: @escaping @Sendable () async throws -> MintedToken,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.store = Store(fetchToken: fetchToken, now: now)
    }

    /// A source that POSTs ``url`` (empty JSON body) and reads
    /// ``{ jwt, expires_at }`` from the response — the wire shape of
    /// ``POST /api/v1/external/auth/token`` and of the token-server
    /// template (``expiresAt``, the serialized ``MintedToken`` spelling,
    /// is accepted too). ``headers`` carry the app's own auth (its
    /// session cookie, a bearer, a shared secret). Rejections surface as
    /// ``MintTokenError/rejected(code:detail:)`` carrying the server's
    /// error slug when the body parses, else a synthetic ``http_<status>``;
    /// local failures carry ``token_source_failed``. Throws that same
    /// error for a plain-http ``url`` to a non-loopback host — auth
    /// headers and JWTs must not cross the network in the clear. Redirects
    /// are refused for the same reason: the exchange never leaves ``url``.
    public static func endpoint(_ url: URL, headers: [String: String] = [:]) throws -> TokenSource {
        guard _isSupportedEndpointURL(url) else {
            throw MintTokenError.rejected(
                code: failedCode,
                detail: "TokenSource.endpoint must use https (http is allowed only for "
                    + "localhost): \(url.absoluteString)"
            )
        }
        return TokenSource(fetchToken: { try await _postTokenEndpoint(url: url, headers: headers) })
    }

    /// Only ``https``, or ``http`` specifically to a loopback host — any
    /// other scheme is refused even on localhost, per the cross-SDK contract.
    static func _isSupportedEndpointURL(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https": return true
        case "http": return RealtimeSession.isLoopbackHost(url.host)
        default: return false
        }
    }

    /// A source backed by ``fetchToken`` — called whenever a fresh token is
    /// needed, returning the ``MintedToken`` to use.
    public static func custom(
        _ fetchToken: @escaping @Sendable () async throws -> MintedToken
    ) -> TokenSource {
        TokenSource(fetchToken: fetchToken)
    }

    /// The JWT to send right now: cached while it has more than the refresh
    /// skew left, else one shared re-fetch (concurrent callers await the
    /// same fetch). A failed fetch caches nothing.
    func jwt() async throws -> String {
        try await store.jwt()
    }

    /// Drop the cached token so the next ``jwt()`` re-fetches.
    func invalidate() async {
        await store.invalidate()
    }

    /// Cache + single-flight state, isolated so ``TokenSource`` itself can
    /// stay a plain ``Sendable`` class.
    private actor Store {
        private let fetchToken: @Sendable () async throws -> MintedToken
        private let now: @Sendable () -> Date
        private var cached: MintedToken?
        private var inflight: Task<MintedToken, Error>?

        init(
            fetchToken: @escaping @Sendable () async throws -> MintedToken,
            now: @escaping @Sendable () -> Date
        ) {
            self.fetchToken = fetchToken
            self.now = now
        }

        func jwt() async throws -> String {
            if let cached, cached.expiresAt.timeIntervalSince(now()) > TokenSource.refreshSkew {
                return cached.jwt
            }
            if let inflight {
                return try await inflight.value.jwt
            }
            let fetch = fetchToken
            let task = Task { try await fetch() }
            inflight = task
            defer { inflight = nil }
            let minted = try await task.value
            cached = minted
            return minted.jwt
        }

        func invalidate() {
            cached = nil
        }
    }

    // MARK: Endpoint wire

    /// Build the token POST request. Split out so the wire serialization —
    /// method, headers, and the empty JSON body — is unit-testable without a
    /// network round-trip.
    static func _makeEndpointRequest(url: URL, headers: [String: String]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        return request
    }

    private static func _postTokenEndpoint(
        url: URL, headers: [String: String]
    ) async throws -> MintedToken {
        let request = _makeEndpointRequest(url: url, headers: headers)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(
                for: request, delegate: RedirectRefusingDelegate()
            )
        } catch {
            throw MintTokenError.rejected(
                code: failedCode,
                detail: "token endpoint request failed: \(error.localizedDescription)"
            )
        }
        guard let http = response as? HTTPURLResponse else {
            throw MintTokenError.rejected(
                code: failedCode, detail: "token endpoint: non-HTTP response"
            )
        }
        return try _decodeEndpointResponse(
            status: http.statusCode,
            data: data,
            location: http.value(forHTTPHeaderField: "Location")
        )
    }

    /// Refuses HTTP redirects on the token exchange. URLSession would
    /// otherwise follow a 30x silently — re-sending the auth headers (and
    /// receiving the JWT) wherever it points, including a plain-http
    /// downgrade that construction-time https validation cannot see.
    /// Task-scoped: no other URLSession behavior in the SDK changes.
    final class RedirectRefusingDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    /// Map one endpoint response onto a ``MintedToken`` or a
    /// ``MintTokenError``: a 30x (delivered un-followed by
    /// ``RedirectRefusingDelegate``) and a 2xx body that is not JSON or is
    /// missing ``jwt`` / ``expires_at`` surface as ``token_source_failed``;
    /// any other non-2xx keeps the server's error slug when the rejection
    /// body parses (else a synthetic ``http_<status>``).
    static func _decodeEndpointResponse(
        status: Int, data: Data, location: String? = nil
    ) throws -> MintedToken {
        if (300..<400).contains(status) {
            let target = location.map { " → \($0)" } ?? ""
            throw MintTokenError.rejected(
                code: failedCode,
                detail: "Token endpoint redirected (HTTP \(status)\(target)); redirects are "
                    + "refused so the exchange cannot leave the configured origin."
            )
        }
        guard (200..<300).contains(status) else {
            let (code, message) = _parseErrorDetail(status: status, data: data)
            log.warning(
                "token source rejected status=\(status, privacy: .public) code=\(code, privacy: .public)"
            )
            throw MintTokenError.rejected(code: code, detail: message)
        }
        guard
            let decoded = try? JSONDecoder().decode(EndpointResponse.self, from: data),
            !decoded.jwt.isEmpty,
            let expiresAt = parseExpiresAt(decoded.expiresAt)
        else {
            throw MintTokenError.rejected(
                code: failedCode, detail: "Token endpoint response missing jwt / expires_at."
            )
        }
        return MintedToken(jwt: decoded.jwt, expiresAt: expiresAt)
    }

    /// Extract the server's ``(code, message)`` from a rejection body,
    /// mirroring the reference SDKs' ``parseErrorDetail``: a typed ``code``
    /// when the envelope carries one, else the envelope's ``type``; a body
    /// that does not parse falls back to a synthetic ``http_<status>``.
    static func _parseErrorDetail(status: Int, data: Data) -> (code: String, message: String) {
        let fallback = "http_\(status)"
        let text = String(String(data: data, encoding: .utf8)?.prefix(500) ?? "")
        guard
            let payload = try? JSONDecoder().decode(JSONValue.self, from: data),
            case .object(let object) = payload
        else {
            return (fallback, text)
        }

        if case .object(let error)? = object["error"] {
            if case .string(let code)? = error["code"], case .string(let message)? = error["message"] {
                return (code, message)
            }
            if case .object(let typed)? = error["message"], typed["code"] != nil {
                return (_stringified(typed["code"]), _stringified(typed["message"]))
            }
            var type = fallback
            if case .string(let value)? = error["type"], !value.isEmpty { type = value }
            if case .string(let message)? = error["message"] {
                return (type, message)
            }
            return (type, text)
        }

        if case .object(let detail)? = object["detail"], detail["code"] != nil {
            return (_stringified(detail["code"]), _stringified(detail["message"]))
        }
        if case .string(let detail)? = object["detail"] {
            return (fallback, detail)
        }
        return (fallback, text)
    }

    private static func _stringified(_ value: JSONValue?) -> String {
        switch value {
        case .string(let v): return v
        case .int(let v): return String(v)
        case .double(let v): return String(v)
        case .bool(let v): return String(v)
        case .null, .array, .object, .none: return ""
        }
    }

    private struct EndpointResponse: Decodable {
        let jwt: String
        let expiresAt: String

        enum CodingKeys: String, CodingKey {
            case jwt
            case expiresAt = "expires_at"
            case expiresAtAlias = "expiresAt"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            jwt = try container.decode(String.self, forKey: .jwt)
            // ``expires_at`` is the wire shape (a forwarded mint response);
            // ``expiresAt`` is a serialized SDK ``MintedToken`` — a backend
            // returning its mint result as-is emits this spelling.
            if let canonical = try container.decodeIfPresent(String.self, forKey: .expiresAt) {
                expiresAt = canonical
            } else {
                expiresAt = try container.decode(String.self, forKey: .expiresAtAlias)
            }
        }
    }

    /// Tolerates the backend's ISO-8601 ``expires_at`` with or without
    /// fractional seconds (FastAPI emits either depending on the value).
    private static func parseExpiresAt(_ raw: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}
