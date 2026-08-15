import Foundation

extension RealtimeSession {

    /// Place an outbound phone call into this running session.
    ///
    /// No start-time flag is needed — the server derives phone handling
    /// from the dialed leg itself. POSTs ``phoneNumber`` (and the
    /// optional ``callerNumber``) to the session's dial endpoint and returns
    /// the server-minted ``dial_id``. To end the call, call ``end()``.
    ///
    /// Both numbers are validated as E.164 (``+`` followed by 8–15 digits)
    /// before the request. Throws ``RealtimeSessionError/invalidPayload(_:)`` on
    /// a malformed number, ``RealtimeSessionError/notConnected`` outside an
    /// active session, and the same rejection cases as session start
    /// (``RealtimeSessionError/handshakeFailed(status:code:detail:)`` /
    /// ``RealtimeSessionError/sessionStartFailed(message:)``) on a server error.
    public func dial(phoneNumber: String, callerNumber: String? = nil) async throws -> String {
        try _assertSendable()
        try validateE164(phoneNumber, field: "phone_number")
        if let callerNumber {
            try validateE164(callerNumber, field: "caller_number")
        }
        guard let options, let sessionId else {
            throw RealtimeSessionError.notConnected
        }

        let request: URLRequest
        do {
            request = try await Self._makeDialRequest(
                options: options,
                sessionId: sessionId,
                phoneNumber: phoneNumber,
                callerNumber: callerNumber
            )
        } catch {
            throw RealtimeSessionError.sessionStartFailed(message: error.localizedDescription)
        }

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = options.requestTimeout
        configuration.timeoutIntervalForResource = options.requestTimeout
        let session = makeRESTSession(
            configuration: configuration,
            verifyTLS: options.verifyTLS,
            host: options.baseURL.host
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw RealtimeSessionError.sessionStartFailed(message: error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw RealtimeSessionError.sessionStartFailed(message: "dial: non-HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do {
                return try JSONDecoder().decode(DialResponse.self, from: data).dialId
            } catch {
                throw RealtimeSessionError.sessionStartFailed(
                    message: "dial response decode failed: \(error.localizedDescription)"
                )
            }
        default:
            // Every rejection carries a typed ``{code, message}`` body — 422
            // schema errors and business rejections alike (400
            // caller_number_not_available, 403 minute_limit_exceeded, 409
            // ended/already-dialed). Surface the code for all of them so a
            // caller can tell "unavailable caller-ID" from "out of minutes",
            // matching the TypeScript and Python SDKs.
            let detail = String(data: data, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
            throw RealtimeSessionError.handshakeFailed(
                status: http.statusCode,
                code: detail.flatMap { rejectionCode(inBody: $0) },
                detail: detail ?? HTTPURLResponse.localizedString(
                    forStatusCode: http.statusCode
                )
            )
        }
    }

    /// Minimal decode of the dial response.
    struct DialResponse: Decodable {
        let dialId: String
        enum CodingKeys: String, CodingKey {
            case dialId = "dial_id"
        }
    }

    /// The dial request body — ``caller_number`` stays off the wire when nil.
    struct DialRequestBody: Encodable {
        let phoneNumber: String
        let callerNumber: String?
        enum CodingKeys: String, CodingKey {
            case phoneNumber = "phone_number"
            case callerNumber = "caller_number"
        }
    }

    /// Build the dial POST request. Split out so the wire serialization —
    /// endpoint path, bearer auth header, and the JSON body — is unit-testable
    /// without a network round-trip (the dial endpoint has no generated client
    /// enforcing its shape).
    static func _makeDialRequest(
        options: Options,
        sessionId: String,
        phoneNumber: String,
        callerNumber: String?
    ) async throws -> URLRequest {
        var request = URLRequest(
            url: options.baseURL.appending(
                path: "api/v1/external/realtime/session/\(sessionId)/dial"
            )
        )
        request.httpMethod = "POST"
        request.setValue("Bearer \(try await options.bearerToken())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(RealtimeSession.sdkIdentityHeaderValue, forHTTPHeaderField: "X-Cosmo-SDK")
        request.httpBody = try JSONEncoder().encode(
            DialRequestBody(phoneNumber: phoneNumber, callerNumber: callerNumber)
        )
        return request
    }
}

/// Validate a phone number as E.164: ``+`` then 8–15 digits. Throws
/// ``RealtimeSessionError/invalidPayload(_:)`` naming ``field`` on a mismatch.
func validateE164(_ number: String, field: String) throws {
    let isValid: Bool = {
        guard number.hasPrefix("+") else { return false }
        let digits = number.dropFirst()
        return (8...15).contains(digits.count)
            && digits.allSatisfy { $0.isNumber && $0.isASCII }
    }()
    guard isValid else {
        throw RealtimeSessionError.invalidPayload(
            "\(field) must be E.164 (a '+' followed by 8–15 digits): \(number)"
        )
    }
}
