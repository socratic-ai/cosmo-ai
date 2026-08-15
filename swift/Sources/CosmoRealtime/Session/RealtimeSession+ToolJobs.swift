import CosmoRealtimeAPI
import Foundation

/// The background client-tool primitive's outbound half: a tool whose work
/// outlives the RPC reply budget acks immediately, then lands its terminal
/// result here. Generic protocol vocabulary — every SDK implements it.
extension RealtimeSession {

    /// Deliver a background client tool's terminal result to the agent. The
    /// worker resolves the original tool call from ``jobId`` and injects the
    /// outcome. Called by ``ClientToolJobSink`` when a job completes/fails.
    func _sendToolJobResult(_ result: BackgroundToolResult) async throws {
        try _assertSendable()
        let resultPayload: CosmoRealtimeAPI.Components.Schemas.ToolJobResult.ResultPayload?
        if let object = result.result {
            resultPayload = .init(additionalProperties: try objectContainer(from: object))
        } else {
            resultPayload = nil
        }
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ToolJobResult(
                error: result.error,
                jobId: result.jobId,
                result: resultPayload,
                status: result.status == .completed ? .completed : .failed,
                summary: result.summary,
                toolName: result.toolName,
                _type: .toolJobResult
            )
        )
    }
}
