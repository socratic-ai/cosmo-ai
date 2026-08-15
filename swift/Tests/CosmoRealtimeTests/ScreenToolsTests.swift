import CoreGraphics
import Foundation
import Testing
@testable import CosmoRealtime

/// Canned screen state the screen-tool tests capture and resolve against.
enum ScreenFixtures {
    static func capture(elementCount: Int = 2) -> ScreenCapture {
        ScreenCapture(
            imageJPEG: Data([0xff, 0xd8]),
            elements: (0..<elementCount).map { i in
                ScreenElement(
                    index: i, role: "AXButton", title: "b\(i)", label: nil, value: nil,
                    frame: CGRect(x: Double(i) * 10, y: 0, width: 20, height: 20)
                )
            },
            context: ScreenCaptureContext(appPID: 7, windowFrame: nil)
        )
    }

    static func handle(_ captureID: String, _ index: Int) -> JSONValue {
        .string(FoundElementHandle.encode(captureID: captureID, elementIndex: index))
    }

}

private final class Published: @unchecked Sendable {
    var payloads: [(data: Data, topic: String)] = []
}

private final class Asked: @unchecked Sendable {
    var requests: [ScreenCaptureRequest] = []
}

/// Mutable wall clock so the TTL step runs without sleeping.
private final class TestClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_000)
}

private func captureSlot(_ tool: SessionConfig.Tool) -> ScreenLocateTool? {
    guard case let .screenLocate(slot) = tool else { return nil }
    return slot
}

private func renderer(_ tool: SessionConfig.Tool) -> ClientToolHandler? {
    guard case let .sdkClient(spec) = tool else { return nil }
    return spec.handler
}

@Suite("screen capture slot")
struct ScreenLocateSlotTests {
    @Test("the capture RPC and its byte-stream topic keep their wire names")
    func wireNames() {
        #expect(ScreenLocateTool.rpcMethod == "screen_capture")
        #expect(ScreenLocateTool.byteStreamTopic == "screen_capture")
    }

    @Test("a capture is cached under its id, published, and acked")
    func capturePublishesAndCaches() async throws {
        let cache = ScreenCaptureCache()
        let published = Published()
        let slot = try #require(
            captureSlot(.screenLocate(cache: cache) { ScreenFixtures.capture() })
        )
        slot.bindPublish { data, topic in published.payloads.append((data, topic)) }

        let reply = try await slot.handler()(["capture_id": .string("cap1")])

        #expect(reply["captured"] == .bool(true))
        #expect(published.payloads.count == 1)
        let sent = try #require(published.payloads.first)
        #expect(sent.topic == ScreenLocateTool.byteStreamTopic)
        let json = try #require(
            try JSONSerialization.jsonObject(with: sent.data) as? [String: Any]
        )
        #expect(json["capture_id"] as? String == "cap1")
        #expect(json["mime_type"] as? String == "image/jpeg")
        #expect((json["ax_elements"] as? [[String: Any]])?.count == 2)
        #expect(cache.get("cap1")?.elements.count == 2)
    }

    @Test("an element's descriptors are clamped, never shipped whole")
    func descriptorsAreClamped() throws {
        // A focused text area holding a document used to reach the backend
        // whole, where a length cap rejected the *entire* capture.
        let capture = ScreenCapture(
            imageJPEG: Data([0xff, 0xd8]),
            elements: [
                ScreenElement(
                    index: 0, role: "AXTextArea", title: nil, label: nil,
                    value: String(repeating: "v", count: 40_000),
                    frame: CGRect(x: 0, y: 0, width: 20, height: 20)
                )
            ],
            context: ScreenCaptureContext(appPID: 7, windowFrame: nil)
        )

        let data = try ScreenLocateTool.encodePayload(captureID: "cap1", capture: capture)
        let json = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let element = try #require((json["ax_elements"] as? [[String: Any]])?.first)
        #expect((element["value"] as? String)?.count == ScreenLocateTool.valueMaxChars)
    }

    @Test("a named element ships no value — the screenshot already shows it")
    func namedElementDropsValue() throws {
        let capture = ScreenCapture(
            imageJPEG: Data([0xff, 0xd8]),
            elements: [
                ScreenElement(
                    index: 0, role: "AXTextField", title: "Email", label: nil,
                    value: "someone@example.com",
                    frame: CGRect(x: 0, y: 0, width: 20, height: 20)
                )
            ],
            context: ScreenCaptureContext(appPID: 7, windowFrame: nil)
        )

        let data = try ScreenLocateTool.encodePayload(captureID: "cap1", capture: capture)
        let json = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let element = try #require((json["ax_elements"] as? [[String: Any]])?.first)
        #expect(element["value"] == nil)
        #expect(element["title"] as? String == "Email")
    }

    @Test("want_elements:false reaches the handler and strips the list from the payload")
    func pixelsOnlyCaptureSkipsElements() async throws {
        let published = Published()
        let asked = Asked()
        let slot = try #require(
            captureSlot(
                .screenLocate(cache: ScreenCaptureCache()) { request in
                    asked.requests.append(request)
                    return ScreenFixtures.capture()
                })
        )
        slot.bindPublish { data, topic in published.payloads.append((data, topic)) }

        _ = try await slot.handler()(
            ["capture_id": .string("cap1"), "want_elements": .bool(false)]
        )

        #expect(asked.requests == [ScreenCaptureRequest(wantsElements: false)])
        let sent = try #require(published.payloads.first)
        let json = try #require(
            try JSONSerialization.jsonObject(with: sent.data) as? [String: Any]
        )
        #expect((json["ax_elements"] as? [[String: Any]])?.isEmpty == true)
        #expect(json["image_b64"] as? String != nil)
    }

    @Test("a server that sends no want_elements is answered with the list")
    func missingWantElementsStillWalks() async throws {
        let asked = Asked()
        let slot = try #require(
            captureSlot(
                .screenLocate(cache: ScreenCaptureCache()) { request in
                    asked.requests.append(request)
                    return ScreenFixtures.capture()
                })
        )
        slot.bindPublish { _, _ in }

        _ = try await slot.handler()(["capture_id": .string("cap1")])

        #expect(asked.requests == [ScreenCaptureRequest(wantsElements: true)])
    }

    @Test("a host that declines to capture says so instead of erroring")
    func unavailableCaptureIsBenign() async throws {
        let slot = try #require(
            captureSlot(
                .screenLocate(cache: ScreenCaptureCache()) {
                    throw ScreenCaptureUnavailable(message: "screen sharing is off")
                })
        )
        slot.bindPublish { _, _ in Issue.record("a declined capture must publish nothing") }

        let reply = try await slot.handler()(["capture_id": .string("cap1")])

        #expect(reply["captured"] == .bool(false))
        #expect(reply["message"] == .string("screen sharing is off"))
    }

    @Test("an unexpected capture failure surfaces as a tool error")
    func otherCaptureFailuresThrow() async throws {
        struct Boom: Error {}
        let slot = try #require(
            captureSlot(.screenLocate(cache: ScreenCaptureCache()) { throw Boom() })
        )
        slot.bindPublish { _, _ in }

        await #expect(throws: Boom.self) {
            _ = try await slot.handler()(["capture_id": .string("cap1")])
        }
    }
}

@Suite("screen renderers resolve a found_element handle")
struct ScreenRendererResolutionTests {
    private func seeded(_ cache: ScreenCaptureCache, elementCount: Int = 2) {
        cache.put("cap1", ScreenFixtures.capture(elementCount: elementCount))
    }

    @Test("a click reaches the host with the element the handle names")
    func clickResolvesTheElement() async throws {
        let cache = ScreenCaptureCache()
        seeded(cache)
        let seen = LockedBox<ScreenClickRequest?>(nil)
        let handler = try #require(
            renderer(
                .screenClickElement(cache: cache) { request in
                    seen.value = request
                    return .clicked
                })
        )

        let reply = try await handler([
            "found_element": ScreenFixtures.handle("cap1", 1),
            "button": .string("right"),
            "double": .bool(true),
        ])

        #expect(reply == ["clicked": .bool(true)])
        let click = try #require(seen.value)
        #expect(click.element.index == 1)
        #expect(click.element.title == "b1")
        #expect(click.action.button == .right)
        #expect(click.action.double)
        #expect(click.capture.elements.count == 2)
    }

    @Test("a highlight reaches the host with the element the handle names")
    func highlightResolvesTheElement() async throws {
        let cache = ScreenCaptureCache()
        seeded(cache)
        let seen = LockedBox<ScreenHighlightRequest?>(nil)
        let handler = try #require(
            renderer(
                .screenHighlightElement(cache: cache) { request in
                    seen.value = request
                    return .landedOnControl
                })
        )

        let reply = try await handler([
            "found_element": ScreenFixtures.handle("cap1", 0),
            "label": .string("Save"),
            "placement": .string("top"),
            "interaction": .string("press_hold"),
        ])

        #expect(reply == ["shown": .bool(true), "exact": .bool(true)])
        let highlight = try #require(seen.value)
        #expect(highlight.element.index == 0)
        #expect(highlight.label == "Save")
        #expect(highlight.placement == .top)
        #expect(highlight.interaction == .pressHold)
    }

    /// Each of these is a handle the SDK cannot turn into a snapshot, and every one
    /// is answered rather than thrown: the model can locate again, where a tool
    /// error just ends the attempt.
    @Test(
        "an unresolvable handle declines instead of erroring",
        arguments: [("nope", 0), ("cap1", 9)]
    )
    func unresolvableHandlesDecline(captureID: String, index: Int) async throws {
        let cache = ScreenCaptureCache()
        seeded(cache)
        let clickHandler = try #require(
            renderer(
                .screenClickElement(cache: cache) { _ in
                    Issue.record("the host must not be reached")
                    return .clicked
                })
        )
        let highlightHandler = try #require(
            renderer(
                .screenHighlightElement(cache: cache) { _ in
                    Issue.record("the host must not be reached")
                    return .landedOnControl
                })
        )
        let handle = ScreenFixtures.handle(captureID, index)

        let clicked = try await clickHandler(["found_element": handle])
        #expect(clicked["clicked"] == .bool(false))
        #expect(clicked["reason"] == .string(unresolvableHandleReason))

        let shown = try await highlightHandler(["found_element": handle, "label": .string("Save")])
        #expect(shown["shown"] == .bool(false))
        #expect(shown["reason"] == .string(unresolvableHandleReason))
    }

    @Test("a handle older than the cache's window declines")
    func expiredHandleDeclines() async throws {
        let clock = TestClock()
        let cache = ScreenCaptureCache(now: { clock.now })
        seeded(cache)
        let handler = try #require(
            renderer(
                .screenClickElement(cache: cache) { _ in
                    Issue.record("an expired handle must not reach the host")
                    return .clicked
                })
        )

        clock.now += ScreenCaptureCache.maxAge + 1
        let reply = try await handler(["found_element": ScreenFixtures.handle("cap1", 0)])

        #expect(reply["clicked"] == .bool(false))
        #expect(reply["reason"] == .string(unresolvableHandleReason))
    }

    @Test("a host decline carries its own reason through")
    func hostDeclineIsForwarded() async throws {
        let cache = ScreenCaptureCache()
        seeded(cache)
        let handler = try #require(
            renderer(
                .screenClickElement(cache: cache) { _ in
                    .notClicked("the foreground app changed — locate it again")
                })
        )

        let reply = try await handler(["found_element": ScreenFixtures.handle("cap1", 0)])

        #expect(reply["clicked"] == .bool(false))
        #expect(reply["reason"] == .string("the foreground app changed — locate it again"))
    }

    @Test("arguments the SDK cannot decode surface as a tool error, not a decline")
    func malformedArgumentsThrow() async throws {
        let cache = ScreenCaptureCache()
        seeded(cache)
        let handler = try #require(renderer(.screenClickElement(cache: cache) { _ in .clicked }))

        await #expect(throws: ScreenToolError.self) {
            _ = try await handler(["button": .string("left")])
        }
    }
}

@Suite("region spotlight")
struct ScreenHighlightBoxToolTests {
    @Test("the model's own box needs no capture behind it")
    func drawsWithoutACache() async throws {
        let seen = LockedBox<ScreenHighlightBoxRequest?>(nil)
        let handler = try #require(
            renderer(
                .screenHighlightBox { request in
                    seen.value = request
                    return .landedOnControl
                })
        )

        let reply = try await handler([
            "x": .double(0.1), "y": .double(0.2),
            "width": .double(0.3), "height": .double(0.4),
            "label": .string("Save"),
            "element_title": .string("Files changed"),
            "element_role": .string("AXButton"),
        ])

        #expect(reply == ["shown": .bool(true), "exact": .bool(true)])
        let request = try #require(seen.value)
        #expect(request.box == ScreenBox(x: 0.1, y: 0.2, width: 0.3, height: 0.4))
        #expect(request.elementGuess == ScreenElementHint(title: "Files changed", role: "AXButton"))
    }

    @Test("a highlight that only landed on the estimate reports inexact")
    func estimateReportsLowConfidence() async throws {
        let handler = try #require(renderer(.screenHighlightBox { _ in .landedOnEstimate }))

        let reply = try await handler([
            "x": .double(0), "y": .double(0), "width": .double(1), "height": .double(1),
            "label": .string("Save"),
        ])

        #expect(reply == ["shown": .bool(true), "exact": .bool(false)])
    }

    @Test("a decline carries its reason and claims no exactness")
    func declineCarriesItsReason() async throws {
        let handler = try #require(
            renderer(.screenHighlightBox { _ in .notShown("the user stopped sharing their screen") })
        )

        let reply = try await handler([
            "x": .double(0), "y": .double(0), "width": .double(1), "height": .double(1),
            "label": .string("Save"),
        ])

        #expect(
            reply == [
                "shown": .bool(false),
                "reason": .string("the user stopped sharing their screen"),
            ]
        )
    }
}

/// Minimal mutable box so a `@Sendable` handler can hand its argument back to
/// the test that declared it.
private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
