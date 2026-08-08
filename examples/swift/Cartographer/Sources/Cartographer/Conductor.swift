import Foundation
import CosmoRealtime

/// Drives one realtime session and folds everything it emits into
/// observable state the UI renders.
@MainActor
final class Conductor: ObservableObject {

    enum Status: Equatable {
        case idle
        case connecting
        case live
        case ended(String)
        case failed(String)

        var caption: String {
            switch self {
            case .idle:        return "Ready"
            case .connecting:  return "Connecting…"
            case .live:        return "Listening"
            case .ended(let r): return r.isEmpty ? "Session ended" : "Ended — \(r)"
            case .failed(let m): return "Failed — \(m)"
            }
        }
    }

    struct Line: Identifiable, Equatable {
        let id = UUID()
        var speaker: Speaker
        var text: String
        var isFinal: Bool
        enum Speaker: String { case you = "you", cosmo = "cosmo", system = "•" }
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var lines: [Line] = []
    @Published private(set) var toolFeed: [String] = []
    @Published private(set) var agentSpeaking = false
    @Published private(set) var youSpeaking = false
    @Published var muted = false

    let map: MindMap

    private var session: RealtimeSession?
    private var pump: Task<Void, Never>?
    /// Index of the still-open line per speaker, so streaming deltas append
    /// in place instead of spawning a new bubble per fragment.
    private var openLine: [Line.Speaker: Int] = [:]

    init(map: MindMap) {
        self.map = map
    }

    // MARK: Session lifecycle

    func start() async {
        guard case .idle = status else { return }
        status = .connecting
        note("connecting to Cosmo…")

        do {
            // Zero-argument Options resolves COSMO_API_KEY, else the
            // `cosmo login` credentials file. A bundled app launched from
            // Finder inherits no environment, so the file is the route that
            // works there.
            let session = try await RealtimeSession.start(
                .init(),
                config: SessionConfig(
                    voice: .init(name: "Upbeat"),
                    audio: .init(noiseCancellation: true),
                    instructions: Self.instructions,
                    tools: try mapTools(),
                    interruptionSensitivity: .high,
                    greeting: "Map's open. What are we thinking about?",
                    hooks: try mapHooks()
                )
            )
            self.session = session
            pump = Task { [weak self] in await self?.consume(session) }
        } catch {
            status = .failed(Self.describe(error))
            note("start failed: \(error)")
        }
    }

    func stop() async {
        guard let session else { return }
        note("hanging up…")
        await session.end()
    }

    func toggleMute() async {
        guard let session else { return }
        let next = !muted
        do {
            try await session.setMuted(next)
            muted = next
            note(next ? "mic muted" : "mic live")
        } catch {
            note("could not toggle mic: \(error)")
        }
    }

    func say(_ text: String) async {
        guard let session, !text.isEmpty else { return }
        append(.you, text, isFinal: true)
        try? await session.send(text: text)
    }

    // MARK: Event pump

    private func consume(_ session: RealtimeSession) async {
        do {
            for try await event in session.events {
                // The `ready` frame can be lost to a race between the agent
                // publishing it and our data channel being subscribed, so it
                // is not safe to gate the UI on it. Anything arriving on this
                // stream proves the session is live.
                markLive()

                switch event {
                case .ready(let ready):
                    note("live — session \(ready.sessionId)")
                    for rejected in ready.rejectedTools ?? [] {
                        note("⚠︎ server rejected tool '\(rejected.name)'")
                    }

                case .transcript(let delta):
                    let who: Line.Speaker = (delta.role == .user) ? .you : .cosmo
                    // Wire contract: non-final `text` is the new fragment,
                    // final `text` is the whole turn. Append, then replace.
                    let text = Self.clean(delta.text)
                    if delta.isFinal {
                        replace(who, text)
                    } else {
                        append(who, text, isFinal: false)
                    }

                case .userStartedSpeaking:  youSpeaking = true
                case .userStoppedSpeaking:  youSpeaking = false
                case .botStartedSpeaking:   agentSpeaking = true
                case .botStoppedSpeaking:   agentSpeaking = false

                case .turnComplete:
                    closeAll()

                case .toolInvocation(let call):
                    tool("→ \(call.name)")

                case .error(let err):
                    note("server error [\(err.code.rawValue)] \(err.message)")

                case .sessionEnded(let ended):
                    status = .ended(ended.reason ?? "")
                    note("session ended: \(ended.reason ?? "—")")

                case .unknown(let rawType, _):
                    note("unknown event: \(rawType ?? "<opaque>")")

                default:
                    break
                }
            }
        } catch {
            status = .failed(Self.describe(error))
            note("stream error: \(error)")
        }
        self.session = nil
        if case .live = status { status = .ended("") }
    }

    /// Latch the session live on the first sign of life, whatever it is.
    private func markLive() {
        if case .connecting = status {
            status = .live
        }
    }

    // MARK: Tools

    private func mapTools() throws -> [SessionConfig.Tool] {
        let map = self.map

        let addIdea = try SessionConfig.Tool.define(
            name: "add_idea",
            description: """
            Put one idea on the visible mind map. Call this the moment the \
            user says something worth keeping — do not wait for them to \
            finish. Keep `idea` to a few words.
            """,
            input: .object(
                properties: [
                    "idea": .string(description: "The idea, 1-5 words."),
                    "parent": .string(
                        description: "Existing idea this hangs off. Omit for a new root."
                    ),
                ],
                required: ["idea"]
            )
        ) { (args: AddIdea) -> [String: JSONValue] in
            let node = await MainActor.run { map.add(label: args.idea, parentRef: args.parent) }
            await self.tool("+ \(args.idea)")
            return ["id": .string(node.id), "placed": .bool(true)]
        }

        let linkIdeas = try SessionConfig.Tool.define(
            name: "link_ideas",
            description: """
            Draw a labelled connection between two ideas already on the map \
            when you notice they relate. Use sparingly.
            """,
            input: .object(
                properties: [
                    "from": .string(description: "Source idea id or label."),
                    "to": .string(description: "Target idea id or label."),
                    "relation": .string(description: "Two or three words, e.g. 'blocks', 'feeds into'."),
                ],
                required: ["from", "to", "relation"]
            )
        ) { (args: LinkIdeas) -> [String: JSONValue] in
            let ok = await MainActor.run {
                map.link(from: args.from, to: args.to, relation: args.relation)
            }
            await self.tool(ok ? "⟷ \(args.from) / \(args.to)" : "⟷ failed")
            return ["linked": .bool(ok)]
        }

        let readMap = try SessionConfig.Tool.define(
            name: "read_map",
            description: """
            Read back everything currently on the map. Call before \
            summarising, or when you need to know what is already there.
            """,
            input: .object(properties: [:])
        ) { (_: Empty) -> [String: JSONValue] in
            let outline = await MainActor.run { map.outline() }
            let title = await MainActor.run { map.title }
            await self.tool("👁 read_map")
            return ["title": .string(title), "outline": .string(outline)]
        }

        let titleMap = try SessionConfig.Tool.define(
            name: "title_map",
            description: "Name the map once its subject is clear. Call at most once or twice.",
            input: .object(
                properties: ["title": .string(description: "A short title.")],
                required: ["title"]
            )
        ) { (args: TitleMap) -> [String: JSONValue] in
            await MainActor.run { map.title = args.title }
            await self.tool("✎ \(args.title)")
            return ["ok": .bool(true)]
        }

        return [addIdea, linkIdeas, readMap, titleMap]
    }

    private struct AddIdea: Decodable, Sendable {
        let idea: String
        let parent: String?
    }
    private struct LinkIdeas: Decodable, Sendable {
        let from: String
        let to: String
        let relation: String
    }
    private struct TitleMap: Decodable, Sendable { let title: String }
    private struct Empty: Decodable, Sendable {}

    // MARK: Hooks

    private func mapHooks() throws -> [Hook] {
        let map = self.map
        return [
            // A map past ~40 nodes is unreadable; refuse further growth and
            // tell the model why so it starts pruning instead of retrying.
            try preToolUse(matcher: "add_idea") { _ in
                let full = await MainActor.run { map.nodes.count >= 40 }
                guard full else { return nil }
                return PreToolUseResult(
                    permission: .deny,
                    reason: "The map is full (40 ideas). Summarise or link existing ideas instead."
                )
            },
            sessionEnd { [weak self] ctx in
                await self?.note("teardown: \(ctx.reason.rawValue)\(ctx.detail.map { " — \($0)" } ?? "")")
            },
        ]
    }

    // MARK: Transcript folding

    private func append(_ who: Line.Speaker, _ text: String, isFinal: Bool) {
        guard !text.isEmpty else { return }
        if let i = openLine[who], lines.indices.contains(i) {
            lines[i].text += text
        } else {
            lines.append(Line(speaker: who, text: text, isFinal: isFinal))
            openLine[who] = lines.count - 1
        }
    }

    private func replace(_ who: Line.Speaker, _ text: String) {
        if let i = openLine[who], lines.indices.contains(i) {
            lines[i].text = text
            lines[i].isFinal = true
        } else if !text.isEmpty {
            lines.append(Line(speaker: who, text: text, isFinal: true))
        }
        openLine[who] = nil
    }

    private func closeAll() {
        for (who, i) in openLine where lines.indices.contains(i) {
            lines[i].isFinal = true
            _ = who
        }
        openLine.removeAll()
    }

    private func note(_ text: String) {
        lines.append(Line(speaker: .system, text: text, isFinal: true))
    }

    private func tool(_ text: String) {
        toolFeed.append(text)
        if toolFeed.count > 40 { toolFeed.removeFirst() }
    }

    /// Assistant transcripts sometimes arrive with raw `<span></span>` markup
    /// interleaved with the words. Strip any tags before rendering.
    private static func clean(_ text: String) -> String {
        guard text.contains("<") else { return text }
        return text.replacingOccurrences(
            of: "<[^>]{0,40}>", with: "", options: .regularExpression
        )
    }

    private static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "\(error)"
    }

    private static let instructions = """
    You are Cartographer, a thinking partner that draws while it listens.

    The user thinks out loud. Your job is to turn their stream of thought \
    into a mind map on the screen in front of them, in real time.

    Rules:
    - Call `add_idea` as soon as an idea appears. Do not wait for a pause. \
      A half-formed thought still earns a node.
    - Hang each idea off the right `parent` so the map has shape.
    - Speak rarely and briefly. One short sentence at a time. You are a \
      cartographer, not a commentator. Long stretches of silence from you \
      while the map grows are correct and good.
    - Use `link_ideas` when you spot a real connection the user has not said \
      out loud. Mention it in one sentence when you do.
    - Call `title_map` once the subject is clear.
    - If asked what is on the map, call `read_map` first, then answer.
    """
}
