import Foundation
import Testing

@testable import CosmoRealtime

@Suite("SessionEvent cosmo classification")
struct SessionEventCosmoTests {

    private func classify(_ json: String) -> RealtimeSession.Event {
        guard case .event(let event) = RealtimeSession.classifyFrame(Data(json.utf8)) else {
            Issue.record("expected a classified event, got an envelope chunk")
            return .pong
        }
        return event
    }

    @Test("cosmo.usage classifies into Event.cosmo(.usage)")
    func cosmoUsage() {
        let event = classify(
            #"{"type":"cosmo.usage","input_audio_tokens":10,"total_tokens":42}"#
        )
        guard case .cosmo(.usage(let usage)) = event else {
            Issue.record("expected .cosmo(.usage), got \(event)")
            return
        }
        #expect(usage.inputAudioTokens == 10)
        #expect(usage.totalTokens == 42)
    }

    @Test("an unrecognized cosmo.* type surfaces as unknown, never terminal")
    func unknownCosmoType() {
        let event = classify(#"{"type":"cosmo.future-thing","x":1}"#)
        guard case .unknown(let rawType, _) = event else {
            Issue.record("expected .unknown, got \(event)")
            return
        }
        #expect(rawType == "cosmo.future-thing")
    }

    @Test("ready carries the resolved-agent echo for a registry reference")
    func readyResolvedAgent() {
        let event = classify(
            #"""
            {"type":"ready","session_id":"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
             "agent":{"name":"driver-pay","tools":["cosmo.web_search"]}}
            """#
        )
        guard case .ready(let ready) = event else {
            Issue.record("expected .ready, got \(event)")
            return
        }
        #expect(ready.agent?.name == "driver-pay")
        #expect(ready.agent?.tools == ["cosmo.web_search"])
    }
}
