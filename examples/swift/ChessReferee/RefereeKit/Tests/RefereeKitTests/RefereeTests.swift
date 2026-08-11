import XCTest
@testable import RefereeKit

final class PieceGridTests: XCTestCase {
    func testFENRoundTrip() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
        let grid = PieceGrid(fenPlacement: start)
        XCTAssertEqual(grid?.fenPlacement, start)
    }

    func testRotation() {
        let afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"
        let grid = PieceGrid(fenPlacement: afterE4)!
        XCTAssertEqual(grid.rotated180.rotated180, grid)
        // A rotated multi-digit-free rank flips correctly square by square.
        XCTAssertEqual(grid.rotated180.fenPlacement, "RNBKQBNR/PPP1PPPP/8/3P4/8/8/pppppppp/rnbkqbnr")
    }

    func testMalformedPlacementRejected() {
        XCTAssertNil(PieceGrid(fenPlacement: "rnbqkbnr/pppppppp/8/8"))
        XCTAssertNil(PieceGrid(fenPlacement: "xnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"))
        XCTAssertNil(PieceGrid(fenPlacement: "rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"))
    }
}

final class RefereeTests: XCTestCase {
    private let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"

    /// Feed the same grid `count` times, returning the last event.
    @discardableResult
    private func feed(_ referee: Referee, _ placement: String, times: Int = 3) -> RefereeEvent? {
        let grid = PieceGrid(fenPlacement: placement)!
        var last: RefereeEvent?
        for _ in 0..<times { last = referee.ingest(grid) }
        return last
    }

    func testGameStartLocksOrientation() {
        let referee = Referee()
        XCTAssertEqual(feed(referee, start), .gameStarted)
    }

    func testGameStartFromRotatedCamera() {
        let referee = Referee()
        let rotated = PieceGrid(fenPlacement: start)!.rotated180
        var last: RefereeEvent?
        for _ in 0..<3 { last = referee.ingest(rotated) }
        XCTAssertEqual(last, .gameStarted)

        // With the camera upside down, a white e2–e4 arrives pre-rotated.
        let afterE4 = PieceGrid(fenPlacement: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR")!.rotated180
        var event: RefereeEvent?
        for _ in 0..<3 { event = referee.ingest(afterE4) }
        guard case .legalMove(let san, let mover, _) = event else {
            return XCTFail("expected legalMove, got \(String(describing: event))")
        }
        XCTAssertEqual(san, "e4")
        XCTAssertEqual(mover, "white")
    }

    func testStabilityGateRejectsFlicker() {
        let referee = Referee()
        feed(referee, start)
        // Two frames of a new position then a flicker back: no event.
        let afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"
        XCTAssertNil(referee.ingest(PieceGrid(fenPlacement: afterE4)!))
        XCTAssertNil(referee.ingest(PieceGrid(fenPlacement: afterE4)!))
        XCTAssertNil(referee.ingest(PieceGrid(fenPlacement: start)!))
    }

    func testLegalMoveSequence() {
        let referee = Referee()
        feed(referee, start)
        guard case .legalMove(let san1, "white", _)? =
            feed(referee, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR")
        else { return XCTFail("e4 not recognized") }
        XCTAssertEqual(san1, "e4")

        guard case .legalMove(let san2, "black", let fen)? =
            feed(referee, "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR")
        else { return XCTFail("e5 not recognized") }
        XCTAssertEqual(san2, "e5")
        XCTAssertTrue(fen.hasPrefix("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w"))
    }

    func testCastlingRecognized() {
        let referee = Referee()
        feed(referee, start)
        for placement in [
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",        // e4
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR",      // e5
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R",    // Nf3
            "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R",  // Nc6
            "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R", // Bc4
            "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R", // Bc5
        ] {
            guard case .legalMove? = feed(referee, placement) else {
                return XCTFail("setup move not recognized: \(placement)")
            }
        }
        guard case .legalMove(let san, "white", _)? =
            feed(referee, "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1")
        else { return XCTFail("castling not recognized") }
        XCTAssertEqual(san, "O-O")
    }

    func testIllegalMoveFlagged() {
        let referee = Referee()
        feed(referee, start)
        // White bishop f1 jumps to b5 through its own pawn on e2.
        let event = feed(referee, "rnbqkbnr/pppppppp/8/1B6/8/8/PPPPPPPP/RNBQK1NR")
        guard case .illegalMove(let description, _)? = event else {
            return XCTFail("expected illegalMove, got \(String(describing: event))")
        }
        XCTAssertTrue(description.contains("white bishop"), description)
        XCTAssertTrue(description.contains("f1"), description)
        XCTAssertTrue(description.contains("b5"), description)
    }

    func testOutOfTurnFlagged() {
        let referee = Referee()
        feed(referee, start)
        // Black replies before white ever moved.
        let event = feed(referee, "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR")
        guard case .outOfTurn(let san, let mover)? = event else {
            return XCTFail("expected outOfTurn, got \(String(describing: event))")
        }
        XCTAssertEqual(mover, "black")
        XCTAssertEqual(san, "e5")
    }

    func testScrambledBoard() {
        let referee = Referee()
        feed(referee, start)
        // Half the pieces vanish: not a move at all.
        let event = feed(referee, "8/8/8/8/8/8/PPPPPPPP/RNBQKBNR")
        guard case .boardScrambled? = event else {
            return XCTFail("expected boardScrambled, got \(String(describing: event))")
        }
    }
}
