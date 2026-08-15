import Foundation

/// One skill (the Agent Skills standard): ``name`` + ``description`` are the
/// resident routing signal; ``body`` is loaded on demand via ``cosmo_sdk_load_skill``.
public struct Skill: Sendable, Equatable {
    public let name: String
    public let description: String
    public let body: String

    public init(name: String, description: String, body: String) {
        self.name = name
        self.description = description
        self.body = body
    }
}

public struct SkillParseError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// Parse a SKILL.md document. ``defaultName`` is used when frontmatter omits
/// ``name`` (Agent Skills convention: default to the directory name). Unknown
/// frontmatter keys (``tier``, ``allowed-tools``, ``license``, …) are accepted
/// and ignored — including list-valued ones — and CRLF line endings are
/// normalized, so files authored for other harnesses stay valid.
public func parseSkillMd(_ rawText: String, defaultName: String) throws -> Skill {
    let text = rawText.replacingOccurrences(of: "\r\n", with: "\n")
    guard text.hasPrefix("---\n") else {
        throw SkillParseError("SKILL.md must start with a '---' frontmatter fence")
    }
    let afterOpen = String(text.dropFirst(4))
    let frontmatter: String
    let body: String
    if let range = afterOpen.range(of: "\n---\n") {
        frontmatter = String(afterOpen[..<range.lowerBound])
        body = String(afterOpen[range.upperBound...])
    } else if afterOpen.hasSuffix("\n---") {
        frontmatter = String(afterOpen.dropLast(4))
        body = ""
    } else {
        throw SkillParseError("SKILL.md frontmatter fence is not closed with '---'")
    }

    var fields: [String: String] = [:]
    for rawLine in frontmatter.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        // A YAML list item under an ignored key (e.g. allowed-tools).
        if line == "-" || line.hasPrefix("- ") { continue }
        guard let colon = line.firstIndex(of: ":") else {
            throw SkillParseError("malformed frontmatter line: \(line)")
        }
        let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
        let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        if fields[key] != nil { throw SkillParseError("duplicate frontmatter key: \(key)") }
        fields[key] = value
    }

    guard let description = fields["description"], !description.isEmpty else {
        throw SkillParseError("SKILL.md frontmatter must include a 'description'")
    }
    let name = (fields["name"].map { $0.isEmpty ? defaultName : $0 }) ?? defaultName
    return Skill(
        name: name,
        description: description,
        body: body.trimmingCharacters(in: .whitespacesAndNewlines)
    )
}

/// Load skills from a directory: a directory whose own ``SKILL.md`` exists IS
/// that one skill; otherwise each ``<child>/SKILL.md`` is a skill. A directory
/// yielding no skills returns empty (an unpopulated per-user skills folder is
/// a valid state); a missing path or malformed SKILL.md throws.
public func loadSkills(fromDirectory url: URL) throws -> [Skill] {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
        throw SkillParseError("skills path is not a directory: \(url.path)")
    }
    let own = url.appendingPathComponent("SKILL.md")
    if fm.fileExists(atPath: own.path) {
        let text = try String(contentsOf: own, encoding: .utf8)
        return [try parseSkillMd(text, defaultName: url.lastPathComponent)]
    }
    let children = (try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey]))
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    var skills: [Skill] = []
    for child in children {
        let md = child.appendingPathComponent("SKILL.md")
        guard fm.fileExists(atPath: md.path) else { continue }
        let text = try String(contentsOf: md, encoding: .utf8)
        skills.append(try parseSkillMd(text, defaultName: child.lastPathComponent))
    }
    return skills
}

/// Normalize a ``skills`` array — duplicates throw when the agent is built,
/// not mid-call.
public func resolveSkills(_ skills: [Skill]) throws -> [Skill] {
    var seen = Set<String>()
    for skill in skills {
        guard seen.insert(skill.name).inserted else {
            throw SkillParseError("duplicate skill name: \(skill.name)")
        }
    }
    return skills
}

/// The resident prompt menu; empty when there are no skills.
public func skillsMenuText(_ skills: [Skill]) -> String {
    if skills.isEmpty { return "" }
    let header = "## Skills\nCall cosmo_sdk_load_skill(name) to load private instructions when the conversation reaches the matching path:"
    return header + "\n" + skills.map { "- \($0.name): \(singleLine($0.description))" }.joined(separator: "\n")
}

/// Collapse newlines so a description can never inject extra lines into the
/// menu block embedded in the system instructions.
private func singleLine(_ s: String) -> String {
    s.split(whereSeparator: \.isNewline).joined(separator: " ")
}
