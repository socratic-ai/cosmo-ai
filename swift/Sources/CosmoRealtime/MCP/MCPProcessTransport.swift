import Foundation
import OSLog

// `Foundation.Process` (stdio subprocess spawning) is macOS-only; it does not
// exist on iOS. Guard the whole transport so the SDK still compiles for the
// iOS app, and give `defaultMCPTransportFactory` an iOS fallback (below) that
// throws rather than referencing an unavailable type.
#if os(macOS)

/// MCP stdio transport over a child process: newline-delimited JSON-RPC 2.0
/// on the child's stdin/stdout. One request line per call; replies correlated
/// by integer `id`. Owns the process and a stdout read loop bounded to its
/// lifetime (cancelled on ``close()``).
final class MCPProcessTransport: MCPTransport, @unchecked Sendable {
    private static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "mcp")

    private let process = Process()
    private let stdin = Pipe()
    private let stdout = Pipe()
    private let state: TransportState
    private var readTask: Task<Void, Never>?
    private let requestTimeout: TimeInterval
    private let maxLineBufferBytes: Int

    init(server: McpStdioServer, requestTimeout: TimeInterval = 30, maxLineBufferBytes: Int = 1 << 20) throws {
        self.requestTimeout = requestTimeout
        self.maxLineBufferBytes = maxLineBufferBytes
        process.executableURL = URL(fileURLWithPath: server.command.hasPrefix("/")
            ? server.command
            : "/usr/bin/env")
        process.arguments = server.command.hasPrefix("/")
            ? server.args
            : [server.command] + server.args
        process.environment = Self.defaultInheritedEnvironment().merging(server.env ?? [:]) { _, new in new }
        if let cwd = server.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.standardInput = stdin
        process.standardOutput = stdout
        state = TransportState(writeHandle: stdin.fileHandleForWriting)
        do {
            try process.run()
        } catch {
            throw MCPError.transport("failed to launch \(server.command): \(error.localizedDescription)")
        }
        startReadLoop()
    }

    func request(method: String, paramsJSON: String) async throws -> String {
        let id = await state.nextID()
        let line = #"{"jsonrpc":"2.0","id":\#(id),"method":"\#(method)","params":\#(paramsJSON)}"# + "\n"
        let timeout = requestTimeout
        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { [state] in
                try await withCheckedThrowingContinuation { continuation in
                    Task { await state.send(id: id, line: line, continuation: continuation) }
                }
            }
            group.addTask { [state] in
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                await state.timeoutIfPending(id: id)
                throw MCPError.transport("MCP request '\(method)' timed out after \(timeout)s")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    func notify(method: String, paramsJSON: String) async {
        let line = #"{"jsonrpc":"2.0","method":"\#(method)","params":\#(paramsJSON)}"# + "\n"
        await state.notify(line: line, log: Self.log)
    }

    func close() async {
        readTask?.cancel()
        if process.isRunning {
            process.terminate()
        }
        await state.failAll(MCPError.transport("connection closed"))
    }

    private func startReadLoop() {
        let handle = stdout.fileHandleForReading
        let maxBufferBytes = maxLineBufferBytes
        readTask = Task.detached { [state] in
            var buffer = Data()
            while !Task.isCancelled {
                let chunk = handle.availableData
                if chunk.isEmpty { break }   // EOF
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer[buffer.startIndex..<newline]
                    buffer.removeSubrange(buffer.startIndex...newline)
                    await state.deliver(lineData: Data(lineData), log: MCPProcessTransport.log)
                }
                if buffer.count > maxBufferBytes {
                    await state.failAll(MCPError.transport("MCP stdout line exceeded \(maxBufferBytes) bytes without a newline"))
                    break
                }
            }
            await state.failAll(MCPError.transport("server closed"))
        }
    }

    /// MCP-standard inherited subset (matches the official SDKs' `get_default_environment()`),
    /// overlaid with `server.env` — never the full parent environment (may hold secrets).
    private static let defaultInheritedEnvVars = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]

    private static func defaultInheritedEnvironment() -> [String: String] {
        let parentEnv = ProcessInfo.processInfo.environment
        return defaultInheritedEnvVars.reduce(into: [String: String]()) { result, key in
            if let value = parentEnv[key] { result[key] = value }
        }
    }
}

/// Serializes id allocation + pending-continuation bookkeeping + writes for one process.
private actor TransportState {
    private var counter = 0
    private var pending: [Int: CheckedContinuation<String, Error>] = [:]
    private var closed = false
    private let writeHandle: FileHandle

    init(writeHandle: FileHandle) {
        self.writeHandle = writeHandle
    }

    func nextID() -> Int { counter += 1; return counter }

    func send(id: Int, line: String, continuation: CheckedContinuation<String, Error>) {
        if closed {
            continuation.resume(throwing: MCPError.transport("connection closed"))
            return
        }
        pending[id] = continuation
        do {
            try writeHandle.write(contentsOf: Data(line.utf8))
        } catch {
            pending.removeValue(forKey: id)
            continuation.resume(throwing: MCPError.transport("write failed: \(error.localizedDescription)"))
        }
    }

    func notify(line: String, log: Logger) {
        if closed { return }
        do {
            try writeHandle.write(contentsOf: Data(line.utf8))
        } catch {
            log.warning("MCP notify write failed: \(error.localizedDescription)")
        }
    }

    func deliver(lineData: Data, log: Logger) {
        let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
        guard let id = obj?["id"] as? Int else {
            let preview = String(decoding: lineData.prefix(200), as: UTF8.self)
            if obj == nil {
                log.warning("MCP: unparseable line from server: \(preview)")
            } else {
                log.warning("MCP: server line has no integer id: \(preview)")
            }
            return
        }
        guard let continuation = pending.removeValue(forKey: id) else { return }
        let parsed = obj ?? [:]
        if let error = parsed["error"] as? [String: Any] {
            let message = (error["message"] as? String) ?? "MCP rpc error"
            continuation.resume(throwing: MCPError.rpc(message))
        } else if let result = parsed["result"], let data = try? JSONSerialization.data(withJSONObject: result) {
            continuation.resume(returning: String(decoding: data, as: UTF8.self))
        } else {
            continuation.resume(returning: "{}")
        }
    }

    func timeoutIfPending(id: Int) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(throwing: MCPError.transport("request timed out"))
    }

    func failAll(_ error: MCPError) {
        closed = true
        for (_, continuation) in pending { continuation.resume(throwing: error) }
        pending.removeAll()
    }
}

/// Production transport factory: spawn a real stdio subprocess per server.
public let defaultMCPTransportFactory: MCPTransportFactory = { server in
    try MCPProcessTransport(server: server)
}

#else

/// stdio MCP subprocesses require `Foundation.Process`, which is macOS-only, so
/// on iOS the default factory throws instead of spawning a server.
public let defaultMCPTransportFactory: MCPTransportFactory = { _ in
    throw MCPError.transport("stdio MCP servers are unsupported on iOS")
}

#endif
