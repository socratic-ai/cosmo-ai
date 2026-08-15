import Testing
@testable import CosmoRealtime

@Suite("SKILL.md parsing")
struct SkillTests {
    @Test func parsesFrontmatterAndBody() throws {
        let s = try parseSkillMd("---\nname: activate-card\ndescription: Activate the card.\ntier: hot\nallowed-tools: [send_text, lookup]\n---\nStep 1: ask web or app.\n", defaultName: "ignored")
        // Unknown keys (tier, allowed-tools, …) are accepted and ignored.
        #expect(s == Skill(name: "activate-card", description: "Activate the card.", body: "Step 1: ask web or app."))
    }
    @Test func nameDefaultsToDirectoryName() throws {
        let s = try parseSkillMd("---\ndescription: d\n---\nbody", defaultName: "leave-voicemail")
        #expect(s.name == "leave-voicemail")
    }
    @Test func blockListValuesUnderIgnoredKeysParse() throws {
        let s = try parseSkillMd("---\ndescription: d\nallowed-tools:\n  - Bash\n  - Read\n---\nbody", defaultName: "x")
        #expect(s == Skill(name: "x", description: "d", body: "body"))
    }
    @Test func missingFrontmatterThrows() {
        #expect(throws: SkillParseError.self) { try parseSkillMd("nope", defaultName: "x") }
    }
    @Test func missingDescriptionThrows() {
        #expect(throws: SkillParseError.self) { try parseSkillMd("---\nname: x\n---\nb", defaultName: "x") }
    }
    @Test func duplicateKeyThrows() {
        #expect(throws: SkillParseError.self) { try parseSkillMd("---\ndescription: a\ndescription: b\n---\nx", defaultName: "x") }
    }
    @Test func colonInDescriptionPreserved() throws {
        #expect(try parseSkillMd("---\ndescription: Use this: when X.\n---\nb", defaultName: "x").description == "Use this: when X.")
    }
    @Test func fenceWithNoBody() throws {
        #expect(try parseSkillMd("---\ndescription: d\n---", defaultName: "x").body == "")
    }
    @Test func parsesCRLFLineEndings() throws {
        let s = try parseSkillMd("---\r\nname: activate-card\r\ndescription: Activate.\r\n---\r\nStep 1.\r\n", defaultName: "ignored")
        #expect(s == Skill(name: "activate-card", description: "Activate.", body: "Step 1."))
    }
}
