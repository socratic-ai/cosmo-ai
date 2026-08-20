import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// A client for the external realtime API: the credential and endpoints,
/// the agent factories, and the credential/usage REST reads. Mirrors the
/// Python ``RealtimeClient``. Construct once with your ``Options``; reuse
/// across calls and sessions.
///
/// Sessions are opened through an agent: ``agent(instructions:model:modelOptions:voice:audio:tools:interruptionSensitivity:greeting:skills:mcp:hooks:)``
/// configures an inline persona, ``catalogAgent(_:inputs:voice:tools:mcp:hooks:)``
/// references a workspace catalog agent, and
/// ``RealtimeAgent/start(resumeSessionId:maxSessionSeconds:storeRecording:storeAudio:storeTranscript:storeVideo:micMuted:rpcHandlers:)``
/// opens one run.
///
/// Minting end-user tokens is the one capability deliberately not here: a
/// shipped device app must never mint. The server-side
/// ``mintToken(externalUserId:)`` extension ships in the opt-in
/// `CosmoRealtimeMint` product.
public struct RealtimeClient: Sendable {
    let options: Options
    private let transport: any ClientTransport

    public init(_ options: Options) {
        self.init(options: options, transport: makeRESTTransport(options: options))
    }

    /// Zero-argument construction: resolves an API key the way
    /// ``Options/init(connectTimeout:requestTimeout:verifyTLS:)`` does.
    public init() throws {
        self.init(try Options())
    }

    init(options: Options, transport: any ClientTransport) {
        self.options = options
        self.transport = transport
    }

    /// An inline agent: the persona configured field by field, independent
    /// of any one run. Throws on duplicate skill names — when the agent is
    /// built, not mid-call.
    public func agent(
        instructions: String? = nil,
        model: String? = nil,
        modelOptions: ModelOptions? = nil,
        voice: VoiceConfig? = nil,
        audio: AudioConfig? = nil,
        tools: [AgentTool] = [],
        interruptionSensitivity: InterruptionSensitivity? = nil,
        greeting: String? = nil,
        skills: [Skill] = [],
        mcp: McpRegistry? = nil,
        hooks: [Hook]? = nil
    ) throws -> RealtimeAgent {
        RealtimeAgent(
            client: self,
            instructions: instructions,
            model: model,
            modelOptions: modelOptions,
            voice: voice,
            audio: audio,
            tools: tools,
            interruptionSensitivity: interruptionSensitivity,
            greeting: greeting,
            skills: try resolveSkills(skills),
            mcp: mcp,
            hooks: hooks
        )
    }

    /// A workspace catalog agent, referenced by machine handle (lowercase
    /// ``[a-z0-9-]``, e.g. ``"driver-pay"``). The stored config runs
    /// verbatim; only per-run ride-alongs may accompany the handle —
    /// ``inputs`` for template placeholders, client ``tools``, the
    /// ``voice``, MCP servers, and client hooks.
    public func catalogAgent(
        _ name: String,
        inputs: [String: String]? = nil,
        voice: VoiceConfig? = nil,
        tools: [AgentTool] = [],
        mcp: McpRegistry? = nil,
        hooks: [Hook]? = nil
    ) -> RealtimeAgent {
        RealtimeAgent(
            client: self,
            name: name,
            inputs: inputs,
            voice: voice,
            tools: tools,
            mcp: mcp,
            hooks: hooks
        )
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

extension RealtimeClient {
    /// Client-level settings: credentials, endpoints, and timeouts.
    public struct Options: Sendable {
        /// The session credential. Exactly one form, chosen at construction.
        public enum Credential: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
            /// Workspace-scoped key — server-side only. Opens sessions and
            /// can mint end-user tokens. Never embed this in a distributed
            /// client.
            case apiKey(String)
            /// A minted per-user JWT — scoped to one external user, safe to
            /// embed in a device or browser. Opens sessions but cannot mint.
            case token(String)
            /// A ``TokenSource`` that fetches — and keeps fresh — a minted
            /// per-user JWT itself, so a distributed app never handles
            /// refresh. Opens sessions but cannot mint.
            case tokenSource(TokenSource)

            /// The bearer value sent on the ``Authorization`` header — for a
            /// ``tokenSource(_:)`` credential, the source's current JWT
            /// (fetched or refreshed as needed).
            func bearerToken() async throws -> String {
                switch self {
                case .apiKey(let v), .token(let v): return v
                case .tokenSource(let source): return try await source.jwt()
                }
            }

            public static func == (lhs: Credential, rhs: Credential) -> Bool {
                switch (lhs, rhs) {
                case (.apiKey(let l), .apiKey(let r)): return l == r
                case (.token(let l), .token(let r)): return l == r
                case (.tokenSource(let l), .tokenSource(let r)): return l === r
                default: return false
                }
            }

            public var description: String {
                switch self {
                case .apiKey: return "Credential.apiKey(•••)"
                case .token: return "Credential.token(•••)"
                case .tokenSource: return "Credential.tokenSource(•••)"
                }
            }
            public var debugDescription: String { description }
        }

        public let credential: Credential
        /// The Cosmo API origin: the `baseURL` passed at construction, else
        /// `COSMO_BASE_URL`, else production. Fixed once the options are
        /// built, so one session talks to one backend and a stored
        /// credential cannot be sent somewhere it was not issued for.
        public let baseURL: URL
        /// Timeout for the media-transport join (signaling + ICE).
        public let connectTimeout: TimeInterval
        /// Timeout for the REST session-start request. Sized separately
        /// from ``connectTimeout`` because session provisioning is
        /// bounded by the backend's agent dispatch.
        public let requestTimeout: TimeInterval
        /// TLS verification for the REST session-start call. ``.auto`` (default)
        /// skips verification only for loopback hosts so a self-signed local-dev
        /// backend works; remote hosts are always verified.
        public let verifyTLS: VerifyTLS

        /// `true` only for a ``Credential/apiKey(_:)`` credential — a
        /// minted ``Credential/token(_:)`` (or the ``Credential/tokenSource(_:)``
        /// that fetches one) cannot mint further tokens.
        public var canMint: Bool {
            if case .apiKey = credential { return true }
            return false
        }

        /// The bearer value for this options' credential — awaited per
        /// request so a ``Credential/tokenSource(_:)`` can refresh.
        func bearerToken() async throws -> String {
            try await credential.bearerToken()
        }

        /// ``baseURL`` defaults to ``RealtimeBaseURL/resolve()`` — the
        /// environment override, else production. Pass one explicitly when the
        /// credential itself names the backend that issued it: a stored or
        /// minted credential is only valid against that origin, and resolving
        /// from the environment would send its session start elsewhere.
        public init(
            credential: Credential,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.credential = credential
            self.baseURL = baseURL ?? RealtimeBaseURL.resolve()
            self.connectTimeout = connectTimeout
            self.requestTimeout = requestTimeout
            self.verifyTLS = verifyTLS
        }

        /// Convenience: a workspace api-key credential.
        public init(
            apiKey: String,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.init(
                credential: .apiKey(apiKey),
                baseURL: baseURL,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// Convenience: a minted per-user JWT credential.
        public init(
            token: String,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.init(
                credential: .token(token),
                baseURL: baseURL,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// Convenience: a self-refreshing ``TokenSource`` credential.
        public init(
            tokenSource: TokenSource,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.init(
                credential: .tokenSource(tokenSource),
                baseURL: baseURL,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// Zero-argument construction: the SDK resolves an API key itself —
        /// `COSMO_API_KEY` from the environment, else the `cosmo login`
        /// credentials file (`COSMO_CREDENTIALS_FILE` or
        /// `~/.cosmo/credentials`, profile from `COSMO_PROFILE`). A file
        /// credential brings its own `base_url` along, since a stored key is
        /// only valid against the backend that issued it. Throws
        /// ``CredentialsError`` when nothing resolves, the file is unusable,
        /// or the stored key expired.
        public init(
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) throws {
            try self.init(
                environment: ProcessInfo.processInfo.environment,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// The resolving init against a supplied environment; internal so
        /// tests can inject one without mutating the process environment.
        init(
            environment: [String: String],
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) throws {
            let resolved = try CredentialsFile.resolveFromRuntime(environment: environment)
            var fileBase: URL?
            if let base = resolved.baseURL {
                var raw = base
                while raw.hasSuffix("/") { raw.removeLast() }
                guard let url = URL(string: raw), url.scheme != nil else {
                    throw CredentialsError.fileInvalid(
                        "The resolved base_url is not a URL: \(base). Run: cosmo login"
                    )
                }
                fileBase = url
            }
            self.init(
                credential: .apiKey(resolved.apiKey),
                baseURL: fileBase,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }
    }
}

