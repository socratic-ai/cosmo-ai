import CryptoKit
import Foundation

/// Mint a LiveKit access token (JWT HS256) for E2E tests against a
/// local ``livekit-server --dev``. Matches the algorithm + claim
/// shape LiveKit's own ``TokenGenerator`` uses in their test support
/// — vendorized here so we don't take a build-time dep on LiveKit's
/// internal test utilities.
///
/// Dev defaults: key ``devkey``, secret
/// ``devsecretdevsecretdevsecretdevse`` — must match the local
/// LiveKit dev server's configured key/secret.
struct TokenGenerator {
    let apiKey: String
    let apiSecret: String
    let identity: String
    let room: String
    /// Defaults grant publish + subscribe so a single token works
    /// for both producer and consumer roles in multi-peer tests.
    var canPublish: Bool = true
    var canPublishData: Bool = true
    var canSubscribe: Bool = true
    /// Joins the room as ``ParticipantKind.agent`` — what the worker's
    /// token carries in production. Lets E2E tests model the session
    /// agent for agent-targeted sends and the RPC caller guard.
    var isAgent: Bool = false
    var ttl: TimeInterval = 60 * 60  // 1 hour

    func sign() throws -> String {
        let header: [String: Any] = ["alg": "HS256", "typ": "JWT"]
        let now = Date()
        var videoGrant: [String: Any] = [
            "room": room,
            "roomJoin": true,
            "canPublish": canPublish,
            "canPublishData": canPublishData,
            "canSubscribe": canSubscribe,
        ]
        if isAgent {
            videoGrant["agent"] = true
        }
        var claims: [String: Any] = [
            "iss": apiKey,
            "sub": identity,
            "iat": Int(now.timeIntervalSince1970),
            "exp": Int(now.addingTimeInterval(ttl).timeIntervalSince1970),
            "nbf": Int(now.timeIntervalSince1970),
            "name": identity,
            "video": videoGrant,
        ]
        // livekit-server derives ``ParticipantInfo.Kind`` from the top-level
        // ``kind`` claim (the legacy ``video.agent`` flag alone leaves the
        // participant ``standard`` on current server versions).
        if isAgent {
            claims["kind"] = "agent"
        }
        let encodedHeader = try base64URLEncode(JSONSerialization.data(
            withJSONObject: header, options: [.sortedKeys]
        ))
        let encodedClaims = try base64URLEncode(JSONSerialization.data(
            withJSONObject: claims, options: [.sortedKeys]
        ))
        let signingInput = "\(encodedHeader).\(encodedClaims)"
        guard let signingData = signingInput.data(using: .utf8) else {
            throw TokenError.encodingFailed
        }
        let key = SymmetricKey(data: Data(apiSecret.utf8))
        let signature = HMAC<SHA256>.authenticationCode(for: signingData, using: key)
        let encodedSignature = base64URLEncodeBytes(Data(signature))
        return "\(signingInput).\(encodedSignature)"
    }

    private func base64URLEncode(_ data: Data) throws -> String {
        base64URLEncodeBytes(data)
    }

    private func base64URLEncodeBytes(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    enum TokenError: Error {
        case encodingFailed
    }
}
