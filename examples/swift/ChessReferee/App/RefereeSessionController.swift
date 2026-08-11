import CosmoRealtime
import Foundation
import RefereeKit

/// Tag prefixing the synthetic turn that asks the agent to speak up. The
/// Swift SDK has no way to trigger a response without a user turn (see the
/// README), so the app sends a tagged directive and hides it from its own
/// transcript view.
private let refereeAlertTag = "[referee-alert]"

private let refereeInstructions = """
You are a lively chess referee and companion watching a physical chess game \
through the player's phone camera.

You continuously receive board state as context notes tagged [board]: the \
current FEN, the last move played, and whose turn it is. Track the game \
silently — never narrate or comment on routine legal moves unless asked.

When you receive a message tagged \(refereeAlertTag), a rules violation just \
happened on the board. Immediately call it out loud: name the violation in \
one short, confident, playful sentence (like a friendly club arbiter), then \
tell the players how to fix it (return the piece, make a legal move). Keep \
it under two sentences.

Players may also ask you questions — the position, whose turn it is, whether \
a move would be legal, what the best plan is. Use your tools to answer from \
the live board rather than guessing. Stay warm and brief; this is a family \
game, not a broadcast booth.
"""

@MainActor
final class RefereeSessionController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        case ended(String)
        case failed(String)
    }

    struct TranscriptLine: Identifiable, Equatable {
        let id = UUID()
        let role: String
        var text: String
        var isFinal: Bool
    }

    @Published var phase: Phase = .idle
    @Published var transcript: [TranscriptLine] = []
    @Published var lastVerdict: String = ""

    private var session: RealtimeSession?
    private var eventsTask: Task<Void, Never>?
    private let referee: Referee

    init(referee: Referee) {
        self.referee = referee
    }

    func connect(apiKey: String) async {
        guard case .idle = phase else { return }
        phase = .connecting
        do {
            let options = RealtimeSession.Options(apiKey: apiKey)
            let config = SessionConfig(
                instructions: refereeInstructions,
                tools: [makeBoardTool(), makeAnalysisTool()]
            )
            let session = try await RealtimeSession.start(options, config: config)
            self.session = session
            phase = .live
            eventsTask = Task { [weak self] in
                await self?.consume(session)
            }
        } catch {
            phase = .failed("\(error)")
        }
    }

    func end() async {
        await session?.end()
        eventsTask?.cancel()
        session = nil
        if case .live = phase { phase = .ended("ended by user") }
    }

    /// Forward a referee event into the session: silent context for normal
    /// play, a spoken interjection for violations.
    func handle(_ event: RefereeEvent) {
        guard let session, case .live = phase else { return }
        Task {
            switch event {
            case .gameStarted:
                self.lastVerdict = "Game on — starting position recognized"
                try? await session.send(
                    context: "[board] New game from the starting position. White to move."
                )
            case .legalMove(let san, let mover, let fen):
                self.lastVerdict = "\(mover) played \(san)"
                try? await session.send(
                    context: "[board] \(mover) played \(san). Position (FEN): \(fen)"
                )
            case .illegalMove(let description, let observed):
                self.lastVerdict = "ILLEGAL: \(description)"
                try? await session.send(
                    text: "\(refereeAlertTag) Illegal move on the board: \(description). "
                        + "Observed placement: \(observed). Call it out now."
                )
            case .outOfTurn(let san, let mover):
                self.lastVerdict = "Out of turn: \(mover) played \(san)"
                try? await session.send(
                    text: "\(refereeAlertTag) \(mover) just played \(san) — but it is not "
                        + "\(mover)'s turn. Call it out now."
                )
            case .boardScrambled:
                self.lastVerdict = "Board unclear — waiting for a clean position"
                try? await session.send(
                    context: "[board] The board changed in a way no single move explains "
                        + "(pieces knocked over or mid-adjustment). Waiting for it to settle."
                )
            }
        }
    }

    // MARK: - Client tools

    private struct NoArgs: Decodable, Sendable {}

    private func makeBoardTool() -> SessionConfig.Tool {
        let referee = referee
        return try! SessionConfig.Tool.define(
            name: "get_board_position",
            description: "Current chess position from the camera: FEN and whose turn it is.",
            input: .object(properties: [:])
        ) { (_: NoArgs) in
            [
                "fen": .string(referee.currentFEN),
                "side_to_move": .string(referee.sideToMove),
            ]
        }
    }

    private func makeAnalysisTool() -> SessionConfig.Tool {
        let referee = referee
        return try! SessionConfig.Tool.define(
            name: "get_legal_moves",
            description: "All legal moves in the current position, as from-square to to-square pairs.",
            input: .object(properties: [:])
        ) { (_: NoArgs) in
            let board = referee.board
            let color = board.position.sideToMove
            var moves: [String] = []
            for piece in board.position.pieces where piece.color == color {
                for target in board.legalMoves(forPieceAt: piece.square) {
                    moves.append("\(piece.square)-\(target)")
                }
            }
            return [
                "side_to_move": .string(referee.sideToMove),
                "legal_moves": .string(moves.joined(separator: ", ")),
            ]
        }
    }

    // MARK: - Event stream

    private func consume(_ session: RealtimeSession) async {
        do {
            for try await event in session.events {
                switch event {
                case .transcript(let delta):
                    apply(role: delta.role == .user ? "user" : "referee",
                          text: delta.text, isFinal: delta.isFinal)
                case .sessionEnded(let ended):
                    phase = .ended(ended.reason ?? "session ended")
                case .error(let error):
                    lastVerdict = "session error: \(error.message)"
                default:
                    break
                }
            }
        } catch {
            if case .live = phase { phase = .failed("\(error)") }
        }
    }

    /// Fold transcript deltas into lines: non-final events carry only the new
    /// fragment (append); the final event carries the whole turn (replace).
    /// Synthetic referee directives are hidden from the visible transcript.
    private func apply(role: String, text: String, isFinal: Bool) {
        if text.hasPrefix(refereeAlertTag) { return }
        if let index = transcript.lastIndex(where: { $0.role == role && !$0.isFinal }) {
            if isFinal {
                transcript[index].text = text
                transcript[index].isFinal = true
            } else {
                transcript[index].text += text
            }
        } else if !text.isEmpty {
            transcript.append(TranscriptLine(role: role, text: text, isFinal: isFinal))
        }
        if transcript.count > 60 {
            transcript.removeFirst(transcript.count - 60)
        }
    }
}
