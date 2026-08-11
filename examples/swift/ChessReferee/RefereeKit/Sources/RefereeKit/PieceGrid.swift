/// An 8×8 grid of FEN piece characters as read off a detected board,
/// row 0 = the top rank as seen by the camera. Orientation-agnostic until
/// the referee locks a rotation against the starting position.
public struct PieceGrid: Equatable, Sendable {
    public var cells: [[Character?]]

    public init(cells: [[Character?]]) {
        precondition(cells.count == 8 && cells.allSatisfy { $0.count == 8 })
        self.cells = cells
    }

    public static var empty: PieceGrid {
        PieceGrid(cells: Array(repeating: Array(repeating: nil, count: 8), count: 8))
    }

    public var pieceCount: Int {
        cells.flatMap { $0 }.compactMap { $0 }.count
    }

    /// FEN placement field (ranks joined by `/`, empties run-length encoded),
    /// reading row 0 as rank 8.
    public var fenPlacement: String {
        cells.map { row in
            var out = ""
            var empty = 0
            for cell in row {
                if let piece = cell {
                    if empty > 0 {
                        out += String(empty)
                        empty = 0
                    }
                    out.append(piece)
                } else {
                    empty += 1
                }
            }
            if empty > 0 { out += String(empty) }
            return out
        }.joined(separator: "/")
    }

    /// The grid rotated 180° — the same physical position seen from the
    /// other side of the board.
    public var rotated180: PieceGrid {
        PieceGrid(cells: cells.reversed().map { $0.reversed() })
    }

    /// Parse a FEN placement field back into a grid. Returns nil on a
    /// malformed field.
    public init?(fenPlacement: String) {
        let ranks = fenPlacement.split(separator: "/")
        guard ranks.count == 8 else { return nil }
        var rows: [[Character?]] = []
        for rank in ranks {
            var row: [Character?] = []
            for ch in rank {
                if let n = ch.wholeNumberValue, (1...8).contains(n) {
                    row.append(contentsOf: Array(repeating: nil, count: n))
                } else if "prnbqkPRNBQK".contains(ch) {
                    row.append(ch)
                } else {
                    return nil
                }
            }
            guard row.count == 8 else { return nil }
            rows.append(row)
        }
        self.init(cells: rows)
    }

    /// Squares (as row/col in this grid's own frame) whose contents differ.
    public func changedSquares(from other: PieceGrid) -> [(row: Int, col: Int)] {
        var diffs: [(Int, Int)] = []
        for row in 0..<8 {
            for col in 0..<8 where cells[row][col] != other.cells[row][col] {
                diffs.append((row, col))
            }
        }
        return diffs
    }
}
