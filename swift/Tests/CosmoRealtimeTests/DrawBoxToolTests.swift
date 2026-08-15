import Foundation
import Testing
@testable import CosmoRealtime

@Suite("cosmo_sdk_draw_box contract + decode")
struct DrawBoxToolTests {
    @Test("wire name is the pinned, backend-legal value")
    func wireName() {
        // Pin the wire name: a rename is a wire break.
        #expect(DrawBoxTool.name == "cosmo_sdk_draw_box")
        // Mirrors the backend regex `^[a-z][a-z0-9_]{2,63}$` from client_declared.py.
        let pattern = #/^[a-z][a-z0-9_]{2,63}$/#
        #expect(DrawBoxTool.name.wholeMatch(of: pattern) != nil)
    }

    @Test("parametersJSON is a wire-legal object requiring box")
    func parametersSchema() throws {
        let object = try #require(
            JSONSerialization.jsonObject(with: Data(DrawBoxTool.parametersJSON.utf8)) as? [String: Any]
        )
        #expect(object["type"] as? String == "object")
        #expect(object["required"] as? [String] == ["box"])
        let properties = try #require(object["properties"] as? [String: Any])
        let box = try #require(properties["box"] as? [String: Any])
        #expect(box["required"] as? [String] == ["x", "y", "width", "height"])
    }

    @Test("declaredTool carries the tool's identity")
    func declaration() {
        let declared = DrawBoxTool.declaredTool()
        #expect(declared.name == DrawBoxTool.name)
        #expect(declared.description == DrawBoxTool.toolDescription)
        #expect(declared.group == "ui")
    }

    @Test("decodes a well-formed box with a label")
    func decodesValidRequest() throws {
        let args: [String: JSONValue] = [
            "box": .object([
                "x": .double(0.1), "y": .double(0.2),
                "width": .double(0.3), "height": .double(0.4),
            ]),
            "label": .string("blush here"),
        ]
        let request = try #require(DrawBoxTool.request(from: args))
        #expect(request.box == NormalizedBox(x: 0.1, y: 0.2, width: 0.3, height: 0.4))
        #expect(request.label == "blush here")
    }

    @Test("accepts integer-valued coordinates")
    func decodesIntegerCoordinates() throws {
        // The model may emit a coordinate as a bare 0/1 (JSON int, not 0.0).
        let args: [String: JSONValue] = [
            "box": .object(["x": .int(0), "y": .int(0), "width": .int(1), "height": .int(1)]),
        ]
        let request = try #require(DrawBoxTool.request(from: args))
        #expect(request.box == NormalizedBox(x: 0, y: 0, width: 1, height: 1))
        #expect(request.label == nil)
    }

    @Test("clamps out-of-range coordinates into [0,1]")
    func clampsOutOfRange() throws {
        let args: [String: JSONValue] = [
            "box": .object([
                "x": .double(-0.2), "y": .double(1.5),
                "width": .double(0.5), "height": .double(2.0),
            ]),
        ]
        let request = try #require(DrawBoxTool.request(from: args))
        #expect(request.box == NormalizedBox(x: 0, y: 1, width: 0.5, height: 1))
    }

    @Test("returns nil when the box is missing or malformed")
    func rejectsMalformed() {
        // No box at all.
        #expect(DrawBoxTool.request(from: ["label": .string("x")]) == nil)
        // Box present but missing a coordinate.
        #expect(DrawBoxTool.request(from: [
            "box": .object(["x": .double(0.1), "y": .double(0.2), "width": .double(0.3)]),
        ]) == nil)
        // A coordinate is the wrong type.
        #expect(DrawBoxTool.request(from: [
            "box": .object([
                "x": .string("nope"), "y": .double(0.2),
                "width": .double(0.3), "height": .double(0.4),
            ]),
        ]) == nil)
    }
}
