import Foundation
import Testing
@testable import CosmoRealtime

@Suite("JSONValue codable + rawAny")
struct JSONValueTests {

    private func roundTrip(_ value: JSONValue) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    @Test("Round-trip: string")
    func roundTripString() throws {
        let original = JSONValue.string("hello")
        #expect(try roundTrip(original) == original)
    }

    @Test("Round-trip: int")
    func roundTripInt() throws {
        let original = JSONValue.int(42)
        #expect(try roundTrip(original) == original)
    }

    @Test("Round-trip: double")
    func roundTripDouble() throws {
        let original = JSONValue.double(3.14159)
        let decoded = try roundTrip(original)
        // Doubles may decode as int when the value happens to be integral,
        // but 3.14159 is unambiguously a double.
        #expect(decoded == original)
    }

    @Test("Round-trip: bool")
    func roundTripBool() throws {
        #expect(try roundTrip(.bool(true)) == .bool(true))
        #expect(try roundTrip(.bool(false)) == .bool(false))
    }

    @Test("Round-trip: null")
    func roundTripNull() throws {
        #expect(try roundTrip(.null) == .null)
    }

    @Test("Round-trip: nested object {a: {b: [1, 2, \"x\"]}}")
    func roundTripNestedObject() throws {
        let original: JSONValue = .object([
            "a": .object([
                "b": .array([.int(1), .int(2), .string("x")])
            ])
        ])
        #expect(try roundTrip(original) == original)
    }

    @Test("Round-trip: array of objects [{id: 1}, {id: 2}]")
    func roundTripArrayOfObjects() throws {
        let original: JSONValue = .array([
            .object(["id": .int(1)]),
            .object(["id": .int(2)]),
        ])
        #expect(try roundTrip(original) == original)
    }

    @Test("Decoding a JSON null decodes to .null")
    func decodesJSONNull() throws {
        let data = Data("null".utf8)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded == .null)
    }

    @Test("Heterogeneous array [1, \"two\", true, null, {}] decodes element-wise")
    func decodesHeterogeneousArray() throws {
        let data = Data("[1, \"two\", true, null, {}]".utf8)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        guard case .array(let elements) = decoded else {
            Issue.record("expected .array, got \(decoded)")
            return
        }
        #expect(elements.count == 5)
        #expect(elements[0] == .int(1))
        #expect(elements[1] == .string("two"))
        #expect(elements[2] == .bool(true))
        #expect(elements[3] == .null)
        #expect(elements[4] == .object([:]))
    }

    @Test("rawAny returns NSNull / Bool / Int / Double / String / Array / Dict by case")
    func rawAnyTypesAreCorrect() {
        #expect(JSONValue.null.rawAny is NSNull)

        let boolRaw = JSONValue.bool(true).rawAny
        #expect(boolRaw is Bool)
        #expect((boolRaw as? Bool) == true)

        let intRaw = JSONValue.int(7).rawAny
        #expect(intRaw is Int)
        #expect((intRaw as? Int) == 7)

        let doubleRaw = JSONValue.double(2.5).rawAny
        #expect(doubleRaw is Double)
        #expect((doubleRaw as? Double) == 2.5)

        let stringRaw = JSONValue.string("abc").rawAny
        #expect(stringRaw is String)
        #expect((stringRaw as? String) == "abc")

        let arrayRaw = JSONValue.array([.int(1), .int(2)]).rawAny
        let arr = arrayRaw as? [Any]
        #expect(arr?.count == 2)
        #expect((arr?[0] as? Int) == 1)
        #expect((arr?[1] as? Int) == 2)

        let objRaw = JSONValue.object(["k": .string("v")]).rawAny
        let dict = objRaw as? [String: Any]
        #expect((dict?["k"] as? String) == "v")
    }

    @Test("rawAny preserves nested structure")
    func rawAnyNestedStructure() throws {
        let value: JSONValue = .object([
            "outer": .array([
                .object(["inner": .int(9)]),
                .null,
                .bool(false),
            ])
        ])
        let raw = value.rawAny
        let dict = try #require(raw as? [String: Any])
        let outer = try #require(dict["outer"] as? [Any])
        #expect(outer.count == 3)
        let first = try #require(outer[0] as? [String: Any])
        #expect((first["inner"] as? Int) == 9)
        #expect(outer[1] is NSNull)
        #expect((outer[2] as? Bool) == false)
    }

    @Test("Equality: two trees with the same content compare equal")
    func equalityHolds() {
        let a: JSONValue = .object([
            "x": .array([.int(1), .string("y"), .null]),
            "z": .bool(true),
        ])
        let b: JSONValue = .object([
            "x": .array([.int(1), .string("y"), .null]),
            "z": .bool(true),
        ])
        #expect(a == b)

        let c: JSONValue = .object([
            "x": .array([.int(1), .string("y"), .null]),
            "z": .bool(false),  // differs
        ])
        #expect(a != c)
    }

    @Test("rawAny serializes via JSONSerialization (interop sanity)")
    func rawAnyIsJSONSerializable() throws {
        let value: JSONValue = .object([
            "nums": .array([.int(1), .double(2.5)]),
            "flag": .bool(true),
            "name": .string("cosmo"),
            "empty": .null,
        ])
        let raw = value.rawAny
        #expect(JSONSerialization.isValidJSONObject(raw))
        let data = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys])
        // Round-trip back through JSONValue and confirm equality.
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded == value)
    }
}
