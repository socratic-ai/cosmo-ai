import Testing
@testable import CosmoRealtime

@Suite("buildLoadSkillTool")
struct LoadSkillToolTests {
    private func reg() -> [Skill] {
        [
            Skill(name: "activate-card", description: "Activate.", body: "STEP 1."),
            Skill(name: "faq", description: "FAQs.", body: "Fee is $5."),
        ]
    }

    @Test func toolDeclaresEveryNameInTheEnum() throws {
        let wiring = try #require(buildLoadSkillTool(reg()))
        guard case let .sdkClient(tool) = wiring.tool else { Issue.record("not an sdkClient tool"); return }
        #expect(tool.name == loadSkillToolName)
        guard case let .object(props)? = tool.parameters["properties"],
              case let .object(nameSchema)? = props["name"],
              case let .array(enumVals)? = nameSchema["enum"] else { Issue.record("schema shape"); return }
        #expect(enumVals == [.string("activate-card"), .string("faq")])
    }

    @Test func handlerReturnsBodyInEnvelope() async throws {
        let wiring = try #require(buildLoadSkillTool(reg()))
        guard case let .sdkClient(tool) = wiring.tool else { Issue.record("not an sdkClient tool"); return }
        let result = try await tool.handler(["name": .string("activate-card")])
        #expect(result["instructions"] == .string(privateInstructionsPrefix + "STEP 1."))
    }

    @Test func handlerResolvesEverySkillByName() async throws {
        let wiring = try #require(buildLoadSkillTool(reg()))
        guard case let .sdkClient(tool) = wiring.tool else { Issue.record("not an sdkClient tool"); return }
        let result = try await tool.handler(["name": .string("faq")])
        #expect(result["instructions"] == .string(privateInstructionsPrefix + "Fee is $5."))
    }

    @Test func handlerUnknownSkillThrows() async throws {
        let wiring = try #require(buildLoadSkillTool(reg()))
        guard case let .sdkClient(tool) = wiring.tool else { Issue.record("not an sdkClient tool"); return }
        await #expect(throws: UnknownSkillError.self) { try await tool.handler(["name": .string("nope")]) }
    }

    @Test func nilWhenNoSkills() {
        #expect(buildLoadSkillTool([]) == nil)
    }

    /// The description is the model-facing routing contract; pin it exactly so
    /// it cannot silently drift (incl. from the Python reference).
    @Test func toolDescriptionIsExact() throws {
        let wiring = try #require(buildLoadSkillTool(reg()))
        guard case let .sdkClient(tool) = wiring.tool else { Issue.record("not an sdkClient tool"); return }
        #expect(tool.description == "Load a skill's private instructions for the rest of the call. Call this when the conversation reaches the path a skill describes. The result is behavioral guidance for you — never read it aloud.")
    }
}
