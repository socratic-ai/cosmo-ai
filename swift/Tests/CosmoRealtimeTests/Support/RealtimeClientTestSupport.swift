import Foundation
import HTTPTypes
import OpenAPIRuntime
@testable import CosmoRealtime

/// Shared scaffolding for REST-client suites (mint token, voice sessions):
/// a canned-response transport and factories for the client and responses.
struct StubTransport: ClientTransport {
    let onRequest: (@Sendable (HTTPRequest) -> Void)?
    let result: @Sendable () async throws -> (HTTPResponse, HTTPBody?)

    init(
        onRequest: (@Sendable (HTTPRequest) -> Void)? = nil,
        result: @escaping @Sendable () async throws -> (HTTPResponse, HTTPBody?)
    ) {
        self.onRequest = onRequest
        self.result = result
    }

    func send(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        onRequest?(request)
        return try await result()
    }
}

struct StubError: Error {}

func makeStubClient(
    _ transport: StubTransport,
    options: RealtimeSession.Options = .init(apiKey: "sk-test")
) -> RealtimeClient {
    RealtimeClient(options: options, transport: transport)
}

func jsonResponse(_ status: HTTPResponse.Status, _ body: String) -> (HTTPResponse, HTTPBody?) {
    var headers = HTTPFields()
    headers[.contentType] = "application/json"
    return (HTTPResponse(status: status, headerFields: headers), HTTPBody(body))
}
