#if DEBUG
import Foundation
import Network

/// Test-only HTTP stub. Binds an ``NWListener`` on an ephemeral
/// port, serves a single canned response per request. Shared
/// between ``CosmoRealtimeTests`` and ``CosmoRealtimeE2ETests``
/// (both ``@testable import CosmoRealtime``) to avoid duplication.
///
/// Not part of the public API — release builds drop it via
/// ``#if DEBUG``.
internal final class LocalHTTPStub: @unchecked Sendable {
    internal struct CannedResponse {
        internal let status: Int
        internal let body: Data?
        internal init(status: Int, body: Data?) {
            self.status = status
            self.body = body
        }
    }

    /// A handle returned by ``holdNext()``. The stub has accepted the
    /// TCP connection and consumed the request bytes but not yet sent a
    /// response. Call ``requestArrived(timeout:)`` to block until the
    /// request is in hand, then ``release(_:)`` to write the canned
    /// response and close the connection.
    internal final class HeldRequest: @unchecked Sendable {
        private let lock = NSLock()
        private var _conn: NWConnection?
        private let arrivedSemaphore = DispatchSemaphore(value: 0)

        fileprivate init() {}

        fileprivate func _fulfill(conn: NWConnection) {
            lock.lock()
            _conn = conn
            lock.unlock()
            arrivedSemaphore.signal()
        }

        /// Suspends until the stub has received and held the request,
        /// or ``timeout`` seconds elapse (whichever comes first).
        internal func requestArrived(timeout: TimeInterval = 1.0) async {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                DispatchQueue.global().async {
                    _ = self.arrivedSemaphore.wait(timeout: .now() + timeout)
                    cont.resume()
                }
            }
        }

        /// Write ``response`` to the held connection and close it,
        /// unblocking the client that is awaiting an HTTP reply.
        internal func release(_ response: CannedResponse) {
            lock.lock()
            let conn = _conn
            _conn = nil
            lock.unlock()
            guard let conn else { return }
            let bodyBytes = response.body ?? Data()
            let statusText = HTTPURLResponse.localizedString(forStatusCode: response.status)
            var header = "HTTP/1.1 \(response.status) \(statusText)\r\n"
            header += "Content-Type: application/json\r\n"
            header += "Content-Length: \(bodyBytes.count)\r\n"
            header += "Connection: close\r\n"
            header += "\r\n"
            var out = Data(header.utf8)
            out.append(bodyBytes)
            conn.send(content: out, completion: .contentProcessed { _ in
                conn.cancel()
            })
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "ai.socratic.cosmo-realtime-sdk.testing.http-stub")
    private let stateLock = NSLock()
    private var _nextResponse: CannedResponse = .init(status: 200, body: nil)
    private var _pendingHold: HeldRequest? = nil
    internal let port: UInt16

    internal init() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params, on: .any)
        self.listener = l
        // ``newConnectionHandler`` must be installed BEFORE start() —
        // connections arriving in the ready→handler-set window are
        // silently dropped, which surfaced as URLErrorDomain -1004
        // earlier.
        var responseProvider: () -> CannedResponse = { .init(status: 200, body: nil) }
        var holdProvider: () -> HeldRequest? = { nil }
        l.newConnectionHandler = { [queue] conn in
            conn.start(queue: queue)
            conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { _, _, _, _ in
                if let held = holdProvider() {
                    // Hand the live connection off to the HeldRequest;
                    // the response will be written when release(_:) is
                    // called. Keep ``conn`` alive by capturing it inside
                    // the HeldRequest via _fulfill.
                    held._fulfill(conn: conn)
                    return
                }
                let canned = responseProvider()
                let bodyBytes = canned.body ?? Data()
                let statusText = HTTPURLResponse.localizedString(forStatusCode: canned.status)
                var header = "HTTP/1.1 \(canned.status) \(statusText)\r\n"
                header += "Content-Type: application/json\r\n"
                header += "Content-Length: \(bodyBytes.count)\r\n"
                header += "Connection: close\r\n"
                header += "\r\n"
                var out = Data(header.utf8)
                out.append(bodyBytes)
                conn.send(content: out, completion: .contentProcessed { _ in
                    conn.cancel()
                })
            }
        }
        var startedPort: UInt16 = 0
        let portReady = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { state in
            if case .ready = state, let p = l.port {
                startedPort = p.rawValue
                portReady.signal()
            }
        }
        l.start(queue: queue)
        _ = portReady.wait(timeout: .now() + .seconds(2))
        guard startedPort != 0 else {
            l.cancel()
            throw URLError(.cannotConnectToHost)
        }
        self.port = startedPort
        responseProvider = { [stateLock, weak self] in
            stateLock.lock()
            defer { stateLock.unlock() }
            return self?._nextResponse ?? .init(status: 200, body: nil)
        }
        holdProvider = { [stateLock, weak self] in
            stateLock.lock()
            defer { stateLock.unlock() }
            guard let self else { return nil }
            let h = self._pendingHold
            self._pendingHold = nil
            return h
        }
    }

    deinit {
        listener.cancel()
    }

    internal func setNextResponse(_ value: CannedResponse) {
        stateLock.lock()
        _nextResponse = value
        stateLock.unlock()
    }

    /// Arms the stub so the **next** incoming request is held rather
    /// than immediately answered. The returned ``HeldRequest`` lets the
    /// test await receipt of the request and later inject a response.
    /// Only one hold can be armed at a time; calling ``holdNext()``
    /// again before the previous request arrives replaces it.
    internal func holdNext() -> HeldRequest {
        let held = HeldRequest()
        stateLock.lock()
        _pendingHold = held
        stateLock.unlock()
        return held
    }
}
#endif
