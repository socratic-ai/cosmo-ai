import SwiftUI
import RefereeKit

@main
struct ChessRefereeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

/// Owns the perception loop: camera frame → (optional) rectified crop →
/// detector → referee → session. Runs detached from the UI at a fixed
/// cadence; inference never runs concurrently with itself.
@MainActor
final class PerceptionLoop: ObservableObject {
    let camera = CameraController()
    let referee = Referee()
    lazy var session = RefereeSessionController(referee: referee)

    @Published var rectifier: BoardRectifier?
    @Published var lastPlacement: String = ""
    @Published var lastBoardBox: CGRect?
    @Published var detectorError: String?
    @Published var running = false

    private var detector: ChessDetector?
    private var loopTask: Task<Void, Never>?

    static let frameInterval: Duration = .milliseconds(500)

    func start() {
        guard loopTask == nil else { return }
        do {
            detector = try ChessDetector(modelURL: Self.modelURL())
        } catch {
            detectorError = "\(error)"
            return
        }
        running = true
        loopTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.step()
                try? await Task.sleep(for: Self.frameInterval)
            }
        }
    }

    func stop() {
        loopTask?.cancel()
        loopTask = nil
        running = false
    }

    private func step() async {
        guard let detector, let frame = camera.currentFrame() else { return }
        let rectifier = rectifier
        let reading: BoardReading? = await Task.detached(priority: .userInitiated) {
            let input = rectifier?.rectify(frame) ?? frame
            return try? detector.readBoard(input)
        }.value
        guard let reading else { return }
        lastPlacement = reading.grid.fenPlacement
        lastBoardBox = reading.boardBox
        if let event = referee.ingest(reading.grid) {
            session.handle(event)
        }
    }

    static func modelURL() -> URL {
        Bundle.main.url(forResource: "yolo9t_chess", withExtension: "onnx")
            ?? URL(fileURLWithPath: "yolo9t_chess.onnx")
    }
}
