import Foundation
import Testing
@testable import CosmoRealtime

@Suite("client-tool schema dialect")
struct ClientToolSchemaDialectTests {
    @Test("every shipped UI tool's schema is legal in the backend dialect")
    func uiToolSchemasAreLegal() {
        // A schema with a disallowed key is rejected at the backend and the tool
        // is silently dropped — it must never reach the model. Pin each one.
        #expect(ClientToolSchemaDialect.firstViolation(inSchemaJSON: DrawBoxTool.parametersJSON) == nil)
        #expect(ClientToolSchemaDialect.firstViolation(inSchemaJSON: DrawPointTool.parametersJSON) == nil)
        #expect(ClientToolSchemaDialect.firstViolation(inSchemaJSON: ScreenClickTool.parametersJSON) == nil)
        #expect(
            ClientToolSchemaDialect.firstViolation(inSchemaJSON: ScreenHighlightTool.parametersJSON)
                == nil)
        #expect(
            ClientToolSchemaDialect.firstViolation(inSchemaJSON: ScreenHighlightBoxTool.parametersJSON)
                == nil)
    }

    @Test("the validator rejects an array-bound key the backend doesn't allow")
    func rejectsDisallowedArrayBounds() {
        // minItems/maxItems are exactly the keys that silently dropped draw_path:
        // legal-looking JSON, not in _SCHEMA_ALLOWED_KEYS.
        let schema = #"{"type":"object","properties":{"points":{"type":"array","minItems":2,"items":{"type":"object"}}}}"#
        let violation = ClientToolSchemaDialect.firstViolation(inSchemaJSON: schema)
        #expect(violation != nil)
        #expect(violation?.contains("minItems") == true)
    }

    @Test("the validator accepts the allowed keyword + bounds set")
    func acceptsAllowedKeywords() {
        // Exercises type/properties/required/items/enum/description/default and the
        // numeric bounds (minimum/maximum/maxLength) — nested so the recursion runs.
        let schema = #"""
        {"type":"object","properties":{"box":{"type":"object","properties":{"x":{"type":"number","minimum":0,"maximum":1}},"required":["x"]},"mode":{"type":"string","enum":["a","b"],"default":"a"},"label":{"type":"string","maxLength":40,"description":"a caption"}},"required":["box"]}
        """#
        #expect(ClientToolSchemaDialect.firstViolation(inSchemaJSON: schema) == nil)
    }

    @Test("the validator catches a disallowed schema type")
    func rejectsDisallowedType() {
        let schema = #"{"type":"tuple","properties":{}}"#
        #expect(ClientToolSchemaDialect.firstViolation(inSchemaJSON: schema)?.contains("tuple") == true)
    }
}
