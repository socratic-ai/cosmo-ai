import Foundation
import LiveKit
import Testing
@testable import CosmoRealtime

/// The join→register race fix relies on LiveKit binding RPC methods on
/// room-local state with no connection: the transport now registers every
/// client-tool method BEFORE ``Room.connect`` so an agent invocation landing
/// in the join window is handled, not "method not found". These tests pin
/// that pre-connect binding capability against LiveKit upgrades.
@Suite("Pre-join RPC registration")
struct PreJoinRpcRegistrationTests {

    @Test("client-tool methods bind on an unconnected room")
    func bindsOnUnconnectedRoom() async throws {
        let room = Room()
        try await registerClientToolHandlers(
            on: room,
            handlers: ["window_tool": { _ in [:] }],
            hooks: nil,
            sessionId: { "sess-1" }
        )
        #expect(await room.isRpcMethodRegistered("window_tool"))
    }

    @Test("background client-tool methods bind on an unconnected room")
    func bindsBackgroundOnUnconnectedRoom() async throws {
        let room = Room()
        let sink = ClientToolJobSink(
            deliver: { _ in },
            isOpen: { true }
        )
        try await registerBackgroundClientToolHandlers(
            on: room,
            handlers: ["bg_tool": { _, _ in }],
            sink: sink,
            hooks: nil,
            sessionId: { nil }
        )
        #expect(await room.isRpcMethodRegistered("bg_tool"))
    }

    @Test("bindClientTools registers both tiers before any join")
    func bindClientToolsRegistersBothTiers() async throws {
        let room = Room()
        let sink = ClientToolJobSink(
            deliver: { _ in },
            isOpen: { true }
        )
        try await LiveKitSessionTransport.bindClientTools(
            on: room,
            clientToolHandlers: ["inline_tool": { _ in [:] }],
            backgroundClientToolHandlers: ["deferred_tool": { _, _ in }],
            clientToolJobSink: sink,
            hooks: nil,
            sessionId: { "sess-2" }
        )
        #expect(await room.isRpcMethodRegistered("inline_tool"))
        #expect(await room.isRpcMethodRegistered("deferred_tool"))
    }
}
