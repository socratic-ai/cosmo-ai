import CoreGraphics
import Foundation
import OnnxRuntimeBindings

/// One detected object in the source image's own pixel space.
public struct Detection: Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let confidence: Double
    public let classIndex: Int

    public var isBoard: Bool { classIndex == ChessDetector.boardClass }
}

/// A completed board read: the placement grid plus the raw geometry it was
/// assembled from, for overlay rendering.
public struct BoardReading: Sendable {
    public let grid: PieceGrid
    public let boardBox: CGRect
    public let detections: [Detection]
}

public enum ChessDetectorError: Error, CustomStringConvertible {
    case modelMissing(URL)
    case pixelBufferFailed
    case unexpectedOutputShape

    public var description: String {
        switch self {
        case .modelMissing(let url):
            return "chess detector model missing at \(url.path); run download-model.sh first"
        case .pixelBufferFailed:
            return "could not render the frame into the detector's input buffer"
        case .unexpectedOutputShape:
            return "model output does not match the expected (1, N, 6) NMS layout"
        }
    }
}

/// YOLOv9-t chess detector: image → FEN-style placement grid.
///
/// A single ONNX model detects the board (class 12) and the 12 piece classes
/// in one pass; the exported graph embeds NMS, so the `output` tensor is
/// `(1, max_det, 6)` rows of `[x1, y1, x2, y2, conf, class]` in the 640×640
/// letterboxed input space. Reads in two passes when the board is small in
/// frame: crop to the detected board and re-read at full input resolution.
public final class ChessDetector {
    public static let inputSize = 640
    public static let boardClass = 12
    static let confidenceThreshold = 0.5
    static let recropBoardPx = 400.0
    static let recropMargin = 0.04

    static let classToFEN: [Int: Character] = [
        0: "p", 1: "r", 2: "n", 3: "b", 4: "q", 5: "k",
        6: "P", 7: "R", 8: "N", 9: "B", 10: "Q", 11: "K",
    ]

    private let session: ORTSession
    private let inputName: String
    private let outputName: String

    public init(modelURL: URL) throws {
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            throw ChessDetectorError.modelMissing(modelURL)
        }
        let env = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        session = try ORTSession(env: env, modelPath: modelURL.path, sessionOptions: options)
        inputName = try session.inputNames().first ?? "images"
        // The export carries a second, pre-NMS `raw` head; the NMS'd `output`
        // tensor is the one this reader consumes.
        let outputs = try session.outputNames()
        outputName = outputs.contains("output") ? "output" : (outputs.first ?? "output")
    }

    // MARK: - Inference

    /// One inference pass, returning detections in `image`'s own pixel space.
    public func detections(in image: CGImage) throws -> [Detection] {
        let side = Self.inputSize
        let width = image.width
        let height = image.height
        let scale = min(Double(side) / Double(width), Double(side) / Double(height))
        let newWidth = Int(Double(width) * scale)
        let newHeight = Int(Double(height) * scale)
        let xOffset = (side - newWidth) / 2
        let yOffset = (side - newHeight) / 2

        let tensor = try letterboxTensor(
            image,
            newWidth: newWidth, newHeight: newHeight,
            xOffset: xOffset, yOffset: yOffset
        )

        let shape: [NSNumber] = [1, 3, NSNumber(value: side), NSNumber(value: side)]
        let input = try ORTValue(
            tensorData: NSMutableData(data: tensor),
            elementType: .float,
            shape: shape
        )
        let outputs = try session.run(
            withInputs: [inputName: input],
            outputNames: [outputName],
            runOptions: nil
        )
        guard let output = outputs[outputName] else {
            throw ChessDetectorError.unexpectedOutputShape
        }
        let data = try output.tensorData() as Data
        let floats = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        guard floats.count % 6 == 0 else {
            throw ChessDetectorError.unexpectedOutputShape
        }

        var boxes: [Detection] = []
        for row in stride(from: 0, to: floats.count, by: 6) {
            let confidence = Double(floats[row + 4])
            guard confidence > Self.confidenceThreshold else { continue }
            let x1 = Double(floats[row])
            let y1 = Double(floats[row + 1])
            let x2 = Double(floats[row + 2])
            let y2 = Double(floats[row + 3])
            // Match the reference reader: truncate to whole source pixels.
            boxes.append(
                Detection(
                    x: ((x1 - Double(xOffset)) / scale).rounded(.towardZero),
                    y: ((y1 - Double(yOffset)) / scale).rounded(.towardZero),
                    width: ((x2 - x1) / scale).rounded(.towardZero),
                    height: ((y2 - y1) / scale).rounded(.towardZero),
                    confidence: confidence,
                    classIndex: Int(floats[row + 5])
                )
            )
        }
        return boxes
    }

    /// Detect board + pieces and assemble the placement grid. Returns nil when
    /// no board is detected in the frame.
    public func readBoard(_ image: CGImage) throws -> BoardReading? {
        var boxes = try detections(in: image)
        guard var board = bestBoard(boxes) else { return nil }

        // Two-pass read: when the board lands small in the letterboxed input
        // (~<50px squares), crop to it and re-read at full input resolution.
        let frameScale = min(
            Double(Self.inputSize) / Double(image.width),
            Double(Self.inputSize) / Double(image.height)
        )
        if frameScale * board.width < Self.recropBoardPx {
            let padX = board.width * Self.recropMargin
            let padY = board.height * Self.recropMargin
            let cropRect = CGRect(
                x: max(0, board.x - padX),
                y: max(0, board.y - padY),
                width: min(Double(image.width), board.x + board.width + padX) - max(0, board.x - padX),
                height: min(Double(image.height), board.y + board.height + padY) - max(0, board.y - padY)
            )
            if cropRect.width > 8, cropRect.height > 8,
               let cropped = image.cropping(to: cropRect) {
                let cropBoxes = try detections(in: cropped)
                // Keep the crop only if it still finds a board; a bad crop must
                // not turn a usable read into no read at all.
                if let cropBoard = bestBoard(cropBoxes) {
                    boxes = cropBoxes
                    board = cropBoard
                }
            }
        }

        let squareW = board.width / 8.0
        let squareH = board.height / 8.0
        guard squareW > 0, squareH > 0 else { return nil }

        var grid = PieceGrid.empty
        var bestConfidence = Array(repeating: Array(repeating: 0.0, count: 8), count: 8)
        for box in boxes where !box.isBoard {
            let centerX = box.x + box.width / 2
            let centerY = box.y + box.height / 2
            let file = Int(((centerX - board.x) / squareW).rounded(.down))
            let rank = Int(((centerY - board.y) / squareH).rounded(.down))
            guard (0..<8).contains(file), (0..<8).contains(rank),
                  box.confidence > bestConfidence[rank][file]
            else { continue }
            bestConfidence[rank][file] = box.confidence
            grid.cells[rank][file] = Self.classToFEN[box.classIndex]
        }

        return BoardReading(
            grid: grid,
            boardBox: CGRect(x: board.x, y: board.y, width: board.width, height: board.height),
            detections: boxes
        )
    }

    private func bestBoard(_ boxes: [Detection]) -> Detection? {
        boxes.filter(\.isBoard).max { $0.confidence < $1.confidence }
    }

    // MARK: - Preprocessing

    /// Letterbox `image` onto a 640×640 canvas and pack it as a normalized
    /// (/255) float32 NCHW RGB tensor.
    private func letterboxTensor(
        _ image: CGImage,
        newWidth: Int, newHeight: Int,
        xOffset: Int, yOffset: Int
    ) throws -> Data {
        let side = Self.inputSize
        let bytesPerRow = side * 4
        var pixels = [UInt8](repeating: 0, count: side * bytesPerRow)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard
            let context = pixels.withUnsafeMutableBytes({ raw -> CGContext? in
                CGContext(
                    data: raw.baseAddress,
                    width: side, height: side,
                    bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                        | CGBitmapInfo.byteOrder32Big.rawValue
                )
            })
        else { throw ChessDetectorError.pixelBufferFailed }

        context.interpolationQuality = .high
        // CG coordinates are bottom-left origin while the bitmap's memory rows
        // run top-down, so a rect placed at the CG-bottom offset lands the
        // image upright with `yOffset` rows of padding above it in memory.
        context.draw(
            image,
            in: CGRect(
                x: xOffset, y: side - yOffset - newHeight,
                width: newWidth, height: newHeight
            )
        )

        var tensor = [Float](repeating: 0, count: 3 * side * side)
        let plane = side * side
        for row in 0..<side {
            for col in 0..<side {
                let pixel = row * bytesPerRow + col * 4
                let index = row * side + col
                tensor[index] = Float(pixels[pixel]) / 255.0
                tensor[plane + index] = Float(pixels[pixel + 1]) / 255.0
                tensor[2 * plane + index] = Float(pixels[pixel + 2]) / 255.0
            }
        }
        return tensor.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
