import ChessKit
import Foundation

/// What the referee concluded from a stable board change.
public enum RefereeEvent: Equatable, Sendable {
    /// The game began: the starting position was recognized (in some rotation).
    case gameStarted

    /// A legal move was played. `fen` is the full FEN after the move.
    case legalMove(san: String, mover: String, fen: String)

    /// The observed position is not reachable by any legal move.
    case illegalMove(description: String, observedPlacement: String)

    /// A legal move — but by the side whose turn it isn't.
    case outOfTurn(san: String, mover: String)

    /// The board no longer matches; pieces changed in a way no single move
    /// explains (knocked pieces, mid-move hand, takeback).
    case boardScrambled(observedPlacement: String)
}

/// Turns a stream of noisy per-frame grids into confident game events.
///
/// Two jobs: a stability gate (a position must be read identically on
/// `stabilityThreshold` consecutive frames before it counts), and move
/// inference — diff the accepted position against the game state and find
/// the legal move that explains it, or rule the change illegal.
public final class Referee {
    public private(set) var board: Board
    private var orientation: Orientation = .unknown
    private var pending: PieceGrid?
    private var pendingCount = 0
    private let stabilityThreshold: Int

    public enum Orientation: Sendable {
        case unknown
        /// Camera row 0 is rank 8 (white at the bottom of the camera frame).
        case whiteBottom
        /// Camera row 0 is rank 1; the grid must be rotated 180°.
        case blackBottom
    }

    public init(stabilityThreshold: Int = 3) {
        self.stabilityThreshold = stabilityThreshold
        self.board = Board(position: .standard)
    }

    public var currentFEN: String { board.position.fen }
    public var sideToMove: String {
        board.position.sideToMove == .white ? "white" : "black"
    }

    /// Reset to a fresh game; orientation re-locks on the next recognized
    /// starting position.
    public func startNewGame() {
        board = Board(position: .standard)
        orientation = .unknown
        pending = nil
        pendingCount = 0
    }

    /// Feed one frame's grid. Returns an event only when a stable, *changed*
    /// position was accepted and classified.
    public func ingest(_ grid: PieceGrid) -> RefereeEvent? {
        // Stability gate: identical read N frames running.
        if grid == pending {
            pendingCount += 1
        } else {
            pending = grid
            pendingCount = 1
        }
        guard pendingCount == stabilityThreshold else { return nil }

        // Orientation locks by recognizing the starting position; until then
        // every stable grid is tested both ways.
        if orientation == .unknown {
            let startPlacement = placement(of: board.position.fen)
            if grid.fenPlacement == startPlacement {
                orientation = .whiteBottom
                return .gameStarted
            }
            if grid.rotated180.fenPlacement == startPlacement {
                orientation = .blackBottom
                return .gameStarted
            }
            return nil
        }

        let oriented = orientation == .whiteBottom ? grid : grid.rotated180
        let observed = oriented.fenPlacement
        guard observed != placement(of: board.position.fen) else { return nil }
        return classify(observed: observed, oriented: oriented)
    }

    // MARK: - Move inference

    private func classify(observed: String, oriented: PieceGrid) -> RefereeEvent {
        // Does any legal move for the side to move produce the observed
        // placement? Promotions are tried through every piece kind.
        if let explanation = legalMoveExplaining(observed, from: board) {
            let mover = board.position.sideToMove == .white ? "white" : "black"
            let san = apply(explanation, to: &board)
            return .legalMove(san: san, mover: mover, fen: board.position.fen)
        }

        // A legal move for the *other* side? That's a real board event worth
        // calling out differently: someone moved out of turn.
        var flipped = boardWithToggledSide(board)
        if let explanation = legalMoveExplaining(observed, from: flipped) {
            let mover = flipped.position.sideToMove == .white ? "white" : "black"
            let san = apply(explanation, to: &flipped)
            return .outOfTurn(san: san, mover: mover)
        }

        // No single legal move explains the change. A 1–4 square diff reads as
        // an attempted (illegal) move; anything bigger is a scrambled board.
        guard let current = PieceGrid(fenPlacement: placement(of: board.position.fen)) else {
            return .boardScrambled(observedPlacement: observed)
        }
        let diffs = oriented.changedSquares(from: current)
        guard (1...4).contains(diffs.count) else {
            return .boardScrambled(observedPlacement: observed)
        }
        return .illegalMove(
            description: describeIllegalChange(diffs, before: current, after: oriented),
            observedPlacement: observed
        )
    }

    private struct Explanation {
        let start: ChessKit.Square
        let end: ChessKit.Square
        let promotion: Piece.Kind?
    }

    /// Search every legal move (and promotion) of `base`'s side to move for
    /// one whose resulting placement matches `observed`.
    private func legalMoveExplaining(_ observed: String, from base: Board) -> Explanation? {
        let color = base.position.sideToMove
        for piece in base.position.pieces where piece.color == color {
            for target in base.legalMoves(forPieceAt: piece.square) {
                var candidate = base
                guard let move = candidate.move(pieceAt: piece.square, to: target) else {
                    continue
                }
                if isPromotion(move) {
                    for kind in [Piece.Kind.queen, .rook, .bishop, .knight] {
                        var attempt = candidate
                        _ = attempt.completePromotion(of: move, to: kind)
                        if placement(of: attempt.position.fen) == observed {
                            return Explanation(start: piece.square, end: target, promotion: kind)
                        }
                    }
                } else if placement(of: candidate.position.fen) == observed {
                    return Explanation(start: piece.square, end: target, promotion: nil)
                }
            }
        }
        return nil
    }

    /// Apply an explanation to `board`, returning the move's SAN.
    private func apply(_ explanation: Explanation, to board: inout Board) -> String {
        guard var made = board.move(pieceAt: explanation.start, to: explanation.end) else {
            return "\(explanation.start)-\(explanation.end)"
        }
        if let kind = explanation.promotion {
            made = board.completePromotion(of: made, to: kind)
        }
        return made.san
    }

    private func isPromotion(_ move: Move) -> Bool {
        move.piece.kind == .pawn && (move.end.rank.value == 1 || move.end.rank.value == 8)
    }

    // MARK: - Descriptions

    private func describeIllegalChange(
        _ diffs: [(row: Int, col: Int)], before: PieceGrid, after: PieceGrid
    ) -> String {
        var vacated: [(String, Character)] = []
        var arrived: [(String, Character)] = []
        for (row, col) in diffs {
            let square = squareName(row: row, col: col)
            let was = before.cells[row][col]
            let now = after.cells[row][col]
            if let was, now == nil { vacated.append((square, was)) }
            if let now, was == nil || was != now { arrived.append((square, now)) }
        }
        if let from = vacated.first, let to = arrived.first {
            return "\(pieceName(from.1)) from \(from.0) to \(to.0) — not a legal move here"
        }
        let squares = diffs.map { squareName(row: $0.row, col: $0.col) }.joined(separator: ", ")
        return "position changed on \(squares) in a way no legal move allows"
    }

    private func squareName(row: Int, col: Int) -> String {
        let file = Character(UnicodeScalar(UInt8(97 + col)))
        return "\(file)\(8 - row)"
    }

    private func pieceName(_ fenChar: Character) -> String {
        let color = fenChar.isUppercase ? "white" : "black"
        let names: [Character: String] = [
            "p": "pawn", "r": "rook", "n": "knight",
            "b": "bishop", "q": "queen", "k": "king",
        ]
        let kind = names[Character(fenChar.lowercased())] ?? "piece"
        return "\(color) \(kind)"
    }

    // MARK: - FEN helpers

    private func placement(of fen: String) -> String {
        String(fen.split(separator: " ").first ?? "")
    }

    private func boardWithToggledSide(_ base: Board) -> Board {
        var parts = base.position.fen.split(separator: " ").map(String.init)
        guard parts.count >= 2 else { return base }
        parts[1] = parts[1] == "w" ? "b" : "w"
        parts[3] = "-"
        guard let position = Position(fen: parts.joined(separator: " ")) else { return base }
        return Board(position: position)
    }
}
