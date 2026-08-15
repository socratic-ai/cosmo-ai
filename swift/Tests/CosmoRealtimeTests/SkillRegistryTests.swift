import Testing
@testable import CosmoRealtime

@Suite("Skills resolution + menu")
struct SkillsResolveTests {
    private let skills = [
        Skill(name: "activate-card", description: "Activate the card.", body: "b1"),
        Skill(name: "faq", description: "Answer FAQs.", body: "b2"),
    ]

    @Test func uniqueListPassesThrough() throws {
        #expect(try resolveSkills(skills) == skills)
    }
    @Test func duplicateNamesThrow() {
        #expect(throws: SkillParseError.self) {
            try resolveSkills(skills + [Skill(name: "faq", description: "dup", body: "d")])
        }
    }
    @Test func menuListsEverySkill() {
        let m = skillsMenuText(skills)
        #expect(m.contains("- activate-card: Activate the card."))
        #expect(m.contains("- faq: Answer FAQs."))
    }
    @Test func menuEmptyWithNoSkills() {
        #expect(skillsMenuText([]) == "")
    }
    @Test func menuCollapsesNewlinesInDescription() {
        // A newline in a description must not inject extra lines into the menu
        // (and thus the system instructions).
        let m = skillsMenuText([Skill(name: "x", description: "line1\nline2", body: "b")])
        #expect(m.hasSuffix("- x: line1 line2"))
    }
}
