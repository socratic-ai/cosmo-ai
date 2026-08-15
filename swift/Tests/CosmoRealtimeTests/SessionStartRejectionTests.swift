import Testing

@testable import CosmoRealtime

/// Session-start rejection bodies carry a machine-readable ``code`` the
/// transport must surface (``version_mismatch`` routing and typed
/// session-start errors depend on it).
@Suite struct SessionStartRejectionTests {

    @Test("external envelope code is extracted")
    func externalEnvelopeCode() {
        let body = """
            {"error": {"type": "api_error", "code": "invalid_tool_config", \
            "message": "Tool 'escalate' references queue X which does not exist."}}
            """
        #expect(rejectionCode(inBody: body) == "invalid_tool_config")
    }

    @Test("external envelope without a code yields nil")
    func externalEnvelopeWithoutCode() {
        let body = """
            {"error": {"type": "validation_error", "message": "Invalid request parameters"}}
            """
        #expect(rejectionCode(inBody: body) == nil)
    }

    @Test("internal detail shape still parses")
    func internalDetailShape() {
        let body = #"{"detail": {"code": "version_mismatch", "message": "upgrade"}}"#
        #expect(rejectionCode(inBody: body) == "version_mismatch")
    }

    @Test("non-JSON and unrelated bodies yield nil")
    func garbageBodies() {
        #expect(rejectionCode(inBody: "not json") == nil)
        #expect(rejectionCode(inBody: #"{"detail": "plain string"}"#) == nil)
    }
}

extension SessionStartRejectionTests {
    @Test("handshakeFailed exposes the rejection code for programmatic branching")
    func handshakeFailedExposesCode() {
        let error = RealtimeSessionError.handshakeFailed(
            status: 422,
            code: "invalid_tool_config",
            detail: "Tool 'escalate' references queue X which does not exist."
        )
        guard case .handshakeFailed(let status, let code, _) = error else {
            Issue.record("expected handshakeFailed")
            return
        }
        #expect(status == 422)
        #expect(code == "invalid_tool_config")
        #expect(error.errorDescription ==
            "Session start rejected (HTTP 422, invalid_tool_config): "
            + "Tool 'escalate' references queue X which does not exist.")
    }
}
