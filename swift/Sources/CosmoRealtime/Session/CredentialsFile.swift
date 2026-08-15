import Foundation

/// Zero-argument credential resolution.
///
/// ``RealtimeSession/Options/init(connectTimeout:requestTimeout:verifyTLS:)``
/// resolves an API key from, in order: `COSMO_API_KEY` in the environment,
/// then the `cosmo login` credentials file (`COSMO_CREDENTIALS_FILE` or
/// `~/.cosmo/credentials`) at the profile named by `COSMO_PROFILE`. The
/// profile's `base_url` travels with the key — a stored credential is only
/// valid against the backend it was issued for — and a `COSMO_BASE_URL`
/// naming a different backend is refused rather than obeyed.
///
/// The file is TOML written exclusively by the Cosmo CLI. Rather than take a
/// TOML dependency, the parser accepts the strict subset the CLI's writer
/// emits — flat tables, basic strings, integers, booleans — and fails closed
/// on anything else.
///
/// Resolution semantics are pinned by the cross-SDK conformance vectors at
/// `credentials-resolution-vectors.json`.
public enum CredentialsError: Error, LocalizedError, Equatable {
    /// No credential anywhere: nothing passed, `COSMO_API_KEY` unset, and
    /// the credentials file absent. The message names every way to supply one.
    case notFound(String)
    /// The requested profile is not in the file; the message lists what is.
    case profileNotFound(String)
    /// The credentials file exists but cannot be used: not TOML, an
    /// unreadable version, or a profile missing required fields.
    case fileInvalid(String)
    /// The stored API key's `expires_at` has passed; `cosmo login` mints a
    /// fresh one.
    case expired(String)
    /// `COSMO_BASE_URL` names a different backend than the one the stored
    /// key was issued by; the conflict is refused up front instead of
    /// earning an unexplained 401.
    case baseURLMismatch(String)

    /// Stable slug shared with the cross-SDK conformance vectors.
    public var code: String {
        switch self {
        case .notFound: return "no_credential"
        case .profileNotFound: return "profile_not_found"
        case .fileInvalid: return "file_invalid"
        case .expired: return "expired"
        case .baseURLMismatch: return "base_url_mismatch"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .notFound(let message), .profileNotFound(let message),
             .fileInvalid(let message), .expired(let message),
             .baseURLMismatch(let message):
            return message
        }
    }
}

struct ResolvedCredential: Equatable {
    enum Source: String {
        case env
        case file
    }

    let apiKey: String
    /// The origin to reach the backend at, or `nil` for the SDK's normal
    /// default. Set when the key came from a profile (its `base_url`) or when
    /// `COSMO_BASE_URL` is set; the environment wins over the profile.
    let baseURL: String?
    let source: Source
}

enum CredentialsFile {
    static let credentialsVersion = 1
    static let defaultProfile = "default"
    static let apiKeyEnvVar = "COSMO_API_KEY"
    static let profileEnvVar = "COSMO_PROFILE"
    static let fileEnvVar = "COSMO_CREDENTIALS_FILE"
    private static let requiredFields = ["slug", "api_key", "api_key_id", "base_url", "expires_at"]

    // MARK: Runtime entry

    static func resolveFromRuntime(environment: [String: String]) throws -> ResolvedCredential {
        let path = resolvePath(environment: environment)
        let text = try readText(path: path)
        return try resolve(environment: environment, fileText: text, pathDisplay: path, now: Date())
    }

    static func resolvePath(environment: [String: String]) -> String {
        if let override = environment[fileEnvVar], !override.isEmpty { return override }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".cosmo/credentials")
    }

    private static func readText(path: String) throws -> String? {
        do {
            return try String(contentsOfFile: path, encoding: .utf8)
        } catch let error as NSError
            where error.domain == NSCocoaErrorDomain
            && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError)
        {
            return nil
        } catch {
            throw CredentialsError.fileInvalid(
                "Cannot read \(path): \(error.localizedDescription) "
                    + "Fix its permissions, or point \(fileEnvVar) elsewhere."
            )
        }
    }

    // MARK: The pure chain

    /// Environment map + file text in, credential out. Split from
    /// ``resolveFromRuntime(environment:)`` so the conformance vectors can
    /// drive it without touching the process environment or filesystem.
    static func resolve(
        environment: [String: String],
        fileText: String?,
        pathDisplay: String,
        now: Date
    ) throws -> ResolvedCredential {
        let envBase = nonEmpty(environment[RealtimeBaseURL.environmentVariable])

        if let envKey = nonEmpty(environment[apiKeyEnvVar]) {
            return ResolvedCredential(apiKey: envKey, baseURL: envBase, source: .env)
        }

        let profile = environment[profileEnvVar].flatMap { $0.isEmpty ? nil : $0 } ?? defaultProfile
        guard let fileText else {
            throw CredentialsError.notFound(
                "No Cosmo credential found. Pass an apiKey or token, set \(apiKeyEnvVar), "
                    + "or sign in with: cosmo login (credentials file checked: \(pathDisplay))"
            )
        }

        let entry = try loadProfile(fileText: fileText, profile: profile, pathDisplay: pathDisplay)
        try rejectExpired(
            expiresAt: entry["expires_at"]!, profile: profile, pathDisplay: pathDisplay, now: now
        )
        try rejectBaseURLConflict(
            envBase: envBase, storedBase: entry["base_url"]!,
            profile: profile, pathDisplay: pathDisplay
        )
        return ResolvedCredential(
            apiKey: entry["api_key"]!,
            baseURL: entry["base_url"]!,
            source: .file
        )
    }

    /// A stored key is only valid where it was minted; a differing
    /// `COSMO_BASE_URL` would send it to a backend that never issued it and
    /// fail as an unexplained 401. Refuse with the remediation instead.
    private static func rejectBaseURLConflict(
        envBase: String?, storedBase: String, profile: String, pathDisplay: String
    ) throws {
        guard let envBase, originKey(envBase) != originKey(storedBase) else { return }
        throw CredentialsError.baseURLMismatch(
            "COSMO_BASE_URL is \(envBase), but the stored key for profile "
                + "'\(profile)' was issued by \(storedBase) (\(pathDisplay)). "
                + "Unset COSMO_BASE_URL, sign in against \(envBase) with `cosmo login`, "
                + "or pass a key for that backend explicitly / via COSMO_API_KEY."
        )
    }

    /// The effective origin — scheme, host, default-aware port — so
    /// `https://x` and `https://x:443/` compare equal. An unparseable value
    /// falls back to plain string comparison (fail closed).
    private static func originKey(_ value: String) -> String {
        var trimmed = value
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased()
        else { return trimmed.lowercased() }
        let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : -1
        let port = components.port ?? defaultPort
        return "\(scheme)://\(host):\(port)"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    private static func loadProfile(
        fileText: String, profile: String, pathDisplay: String
    ) throws -> [String: String] {
        let document = try TomlSubset.parse(fileText, pathDisplay: pathDisplay)
        try rejectUnreadableVersion(document.version, pathDisplay: pathDisplay)

        guard let entry = document.tables[profile] else {
            let present = document.tables.keys.sorted().joined(separator: ", ")
            throw CredentialsError.profileNotFound(
                "No '\(profile)' credentials in \(pathDisplay). "
                    + "Profiles present: \(present.isEmpty ? "(none)" : present). Run: cosmo login"
            )
        }

        var values: [String: String] = [:]
        var missing: [String] = []
        for field in requiredFields {
            if case .string(let value)? = entry[field], !value.isEmpty {
                values[field] = value
            } else {
                missing.append(field)
            }
        }
        guard missing.isEmpty else {
            throw CredentialsError.fileInvalid(
                "Profile '\(profile)' in \(pathDisplay) is missing: "
                    + "\(missing.joined(separator: ", ")). Run: cosmo login"
            )
        }
        return values
    }

    private static func rejectUnreadableVersion(
        _ version: TomlSubset.Value?, pathDisplay: String
    ) throws {
        guard let version else {
            throw CredentialsError.fileInvalid(
                "\(pathDisplay) predates the versioned credentials format. "
                    + "Run: cosmo login (rewrites it, keeping a .bak copy)"
            )
        }
        guard case .integer(let number) = version, number >= 1 else {
            throw CredentialsError.fileInvalid(
                "\(pathDisplay): 'version' must be a positive integer, found \(version.described). "
                    + "Move it aside or delete it, then run: cosmo login"
            )
        }
        if number > credentialsVersion {
            throw CredentialsError.fileInvalid(
                "\(pathDisplay) was written by a newer Cosmo CLI (format \(number); this SDK "
                    + "understands \(credentialsVersion)). Update the CosmoRealtime package."
            )
        }
    }

    private static func rejectExpired(
        expiresAt: String, profile: String, pathDisplay: String, now: Date
    ) throws {
        guard let expiry = parseRfc3339(expiresAt) else {
            throw CredentialsError.fileInvalid(
                "Profile '\(profile)' in \(pathDisplay) has an unreadable expires_at: "
                    + "'\(expiresAt)'. Run: cosmo login"
            )
        }
        if now >= expiry {
            throw CredentialsError.expired(
                "The stored API key for profile '\(profile)' expired at \(expiresAt) "
                    + "(\(pathDisplay)). Run: cosmo login"
            )
        }
    }

    private static func parseRfc3339(_ value: String) -> Date? {
        // `.withInternetDateTime` requires an explicit offset, so a
        // timezone-less timestamp is rejected — matching the other SDKs.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

// MARK: - TOML subset parser

/// The strict subset of TOML the CLI's writer emits: `[table]` headers and
/// `key = value` lines where a value is a basic string, an integer, or a
/// boolean. Anything else fails closed as `file_invalid`.
enum TomlSubset {
    enum Value: Equatable {
        case string(String)
        case integer(Int)
        case boolean(Bool)

        var described: String {
            switch self {
            case .string(let s): return "'\(s)'"
            case .integer(let i): return String(i)
            case .boolean(let b): return String(b)
            }
        }
    }

    struct Document {
        var topLevel: [String: Value] = [:]
        var tables: [String: [String: Value]] = [:]

        var version: Value? { topLevel["version"] }
    }

    private static func invalid(_ pathDisplay: String, _ lineNo: Int, _ reason: String) -> CredentialsError {
        .fileInvalid(
            "\(pathDisplay) is not a readable credentials file (line \(lineNo): \(reason)). "
                + "Move it aside or delete it, then run: cosmo login"
        )
    }

    static func parse(_ text: String, pathDisplay: String) throws -> Document {
        var document = Document()
        var currentTable: String? = nil

        let lines = text.components(separatedBy: .newlines)
        for (index, rawLine) in lines.enumerated() {
            let lineNo = index + 1
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            if line.hasPrefix("[") {
                let name = try parseTableHeader(line, pathDisplay: pathDisplay, lineNo: lineNo)
                guard document.tables[name] == nil else {
                    throw invalid(pathDisplay, lineNo, "duplicate table '\(name)'")
                }
                document.tables[name] = [:]
                currentTable = name
                continue
            }

            guard let eq = line.firstIndex(of: "=") else {
                throw invalid(pathDisplay, lineNo, "expected `key = value`")
            }
            let key = String(line[line.startIndex..<eq]).trimmingCharacters(in: .whitespaces)
            guard isBareKey(key) else {
                throw invalid(pathDisplay, lineNo, "unsupported key '\(key)'")
            }
            let rawValue = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            let value = try parseValue(rawValue, pathDisplay: pathDisplay, lineNo: lineNo)

            if let table = currentTable {
                guard document.tables[table]?[key] == nil else {
                    throw invalid(pathDisplay, lineNo, "duplicate key '\(key)'")
                }
                document.tables[table]?[key] = value
            } else {
                guard document.topLevel[key] == nil else {
                    throw invalid(pathDisplay, lineNo, "duplicate key '\(key)'")
                }
                document.topLevel[key] = value
            }
        }
        return document
    }

    private static func isBareKey(_ key: String) -> Bool {
        !key.isEmpty && key.allSatisfy { $0.isLetter && $0.isASCII || $0.isNumber && $0.isASCII || $0 == "_" || $0 == "-" }
    }

    private static func parseTableHeader(
        _ line: String, pathDisplay: String, lineNo: Int
    ) throws -> String {
        let stripped = stripTrailingComment(line)
        guard stripped.hasSuffix("]") else {
            throw invalid(pathDisplay, lineNo, "unterminated table header")
        }
        let inner = String(stripped.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
        if isBareKey(inner) { return inner }
        if inner.hasPrefix("\"") {
            let (value, rest) = try parseBasicString(inner, pathDisplay: pathDisplay, lineNo: lineNo)
            guard rest.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw invalid(pathDisplay, lineNo, "unsupported table header")
            }
            return value
        }
        throw invalid(pathDisplay, lineNo, "unsupported table header '\(inner)'")
    }

    private static func parseValue(
        _ raw: String, pathDisplay: String, lineNo: Int
    ) throws -> Value {
        if raw.hasPrefix("\"") {
            let (value, rest) = try parseBasicString(raw, pathDisplay: pathDisplay, lineNo: lineNo)
            let trailing = rest.trimmingCharacters(in: .whitespaces)
            guard trailing.isEmpty || trailing.hasPrefix("#") else {
                throw invalid(pathDisplay, lineNo, "unexpected text after string value")
            }
            return .string(value)
        }
        let bare = stripTrailingComment(raw)
        if bare == "true" { return .boolean(true) }
        if bare == "false" { return .boolean(false) }
        if let number = parseInteger(bare) { return .integer(number) }
        throw invalid(pathDisplay, lineNo, "unsupported value '\(bare)'")
    }

    private static func parseInteger(_ raw: String) -> Int? {
        var digits = Substring(raw)
        if digits.hasPrefix("+") || digits.hasPrefix("-") { digits = digits.dropFirst() }
        guard !digits.isEmpty, digits.allSatisfy({ $0.isNumber && $0.isASCII }) else { return nil }
        return Int(raw)
    }

    private static func stripTrailingComment(_ raw: String) -> String {
        guard let hash = raw.firstIndex(of: "#") else {
            return raw.trimmingCharacters(in: .whitespaces)
        }
        return String(raw[raw.startIndex..<hash]).trimmingCharacters(in: .whitespaces)
    }

    private static let escapes: [Character: Character] = [
        "\\": "\\", "\"": "\"", "n": "\n", "t": "\t", "r": "\r",
        "f": "\u{0C}", "b": "\u{08}",
    ]

    private static func parseBasicString(
        _ raw: String, pathDisplay: String, lineNo: Int
    ) throws -> (value: String, rest: String) {
        var out = ""
        var index = raw.index(after: raw.startIndex)  // past the opening quote
        while index < raw.endIndex {
            let ch = raw[index]
            if ch == "\"" {
                return (out, String(raw[raw.index(after: index)...]))
            }
            if ch == "\\" {
                let nextIndex = raw.index(after: index)
                guard nextIndex < raw.endIndex else {
                    throw invalid(pathDisplay, lineNo, "unterminated string")
                }
                let next = raw[nextIndex]
                if next == "u" || next == "U" {
                    let width = next == "u" ? 4 : 8
                    let hexStart = raw.index(after: nextIndex)
                    guard let hexEnd = raw.index(hexStart, offsetBy: width, limitedBy: raw.endIndex)
                    else { throw invalid(pathDisplay, lineNo, "bad unicode escape") }
                    let hex = String(raw[hexStart..<hexEnd])
                    guard hex.count == width, hex.allSatisfy({ $0.isHexDigit }),
                          let scalarValue = UInt32(hex, radix: 16),
                          let scalar = Unicode.Scalar(scalarValue)
                    else { throw invalid(pathDisplay, lineNo, "bad unicode escape") }
                    out.append(Character(scalar))
                    index = hexEnd
                    continue
                }
                guard let mapped = escapes[next] else {
                    throw invalid(pathDisplay, lineNo, "unsupported escape '\\\(next)'")
                }
                out.append(mapped)
                index = raw.index(after: nextIndex)
                continue
            }
            out.append(ch)
            index = raw.index(after: index)
        }
        throw invalid(pathDisplay, lineNo, "unterminated string")
    }
}
