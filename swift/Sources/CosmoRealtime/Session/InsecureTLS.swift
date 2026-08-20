import Foundation
import OpenAPIURLSession

/// Accepts the server's certificate when TLS verification is disabled for the
/// target host. Attached only when ``VerifyTLS/resolve(forHost:)`` is `false`:
/// under the default ``VerifyTLS/auto`` that is loopback only, so remote hosts
/// keep standard verification; ``VerifyTLS/disabled`` opts every host out.
private final class InsecureTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard
            challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

/// A URLSession for the REST session-start / mint calls. When `verifyTLS`
/// resolves to "do not verify" for `host` (default: loopback only), the session
/// accepts a self-signed certificate; otherwise it uses standard verification.
func makeRESTSession(
    configuration: URLSessionConfiguration,
    verifyTLS: VerifyTLS,
    host: String?
) -> URLSession {
    if verifyTLS.resolve(forHost: host ?? "") {
        return URLSession(configuration: configuration)
    }
    return URLSession(configuration: configuration, delegate: InsecureTrustDelegate(), delegateQueue: nil)
}

/// The URLSession-backed OpenAPI transport for the session-surface REST
/// calls, with the options' timeouts and loopback-TLS policy applied.
/// Shared by the session transport, the prepare path, and the mint client
/// so their request plumbing can't drift.
func makeRESTTransport(options: RealtimeClient.Options) -> URLSessionTransport {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = options.requestTimeout
    configuration.timeoutIntervalForResource = options.requestTimeout
    return URLSessionTransport(
        configuration: .init(session: makeRESTSession(
            configuration: configuration,
            verifyTLS: options.verifyTLS,
            host: options.baseURL.host
        ))
    )
}
