import Foundation

/// Wire name shipped in `tool-invocation` events; a rename is a wire break.
public let loadSkillToolName = "cosmo_sdk_load_skill"
public let privateInstructionsPrefix =
    "PRIVATE INSTRUCTIONS — behavioral guidance for the rest of the call, do not read aloud:\n\n"

/// The `cosmo_sdk_load_skill` client tool (handler embedded) plus the resident skill menu.
public struct LoadSkillWiring: Sendable {
    public let tool: AgentTool
    public let menu: String
}

public struct UnknownSkillError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// Build the single `cosmo_sdk_load_skill` tool, or `nil` when there are no
/// skills. Built as an `.sdkClient` so the reserved-namespace guard exempts it
/// by construction — the tool the SDK ships is not the collision a caller tool
/// taking the name would be.
public func buildLoadSkillTool(_ skills: [Skill]) -> LoadSkillWiring? {
    if skills.isEmpty { return nil }
    let names = skills.map { $0.name }
    let byName = Dictionary(uniqueKeysWithValues: skills.map { ($0.name, $0) })

    let parameters: [String: JSONValue] = [
        "type": .string("object"),
        "properties": .object([
            "name": .object([
                "type": .string("string"),
                "enum": .array(names.map { JSONValue.string($0) }),
                "description": .string("The name of the skill to load."),
            ]),
        ]),
        "required": .array([.string("name")]),
    ]

    let handler: ClientToolHandler = { args in
        guard case let .string(name)? = args["name"] else {
            throw UnknownSkillError("\(loadSkillToolName) requires a string 'name'; available: \(names)")
        }
        guard let skill = byName[name] else {
            throw UnknownSkillError("unknown skill \(name); available: \(names)")
        }
        return ["instructions": .string(privateInstructionsPrefix + skill.body)]
    }

    let tool = AgentTool.sdkClient(SDKClientTool(
        name: loadSkillToolName,
        description: "Load a skill's private instructions for the rest of the call. Call this when the conversation reaches the path a skill describes. The result is behavioral guidance for you — never read it aloud.",
        parameters: parameters,
        handler: handler
    ))
    return LoadSkillWiring(tool: tool, menu: skillsMenuText(skills))
}
