import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins

/// One-time corner calibration → perspective-corrected top-down board crop.
///
/// The detector trained on flat 2D board renders, so a photographed board is
/// warped into that world before inference: the user taps the four board
/// corners once, and every frame is perspective-corrected to a square crop.
struct BoardRectifier {
    /// Board corners in normalized image coordinates (0–1, top-left origin),
    /// ordered top-left, top-right, bottom-right, bottom-left as seen.
    var corners: [CGPoint]

    static let outputSide = 800

    private let context = CIContext()

    init?(corners: [CGPoint]) {
        guard corners.count == 4 else { return nil }
        self.corners = corners
    }

    func rectify(_ image: CGImage) -> CGImage? {
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let ciImage = CIImage(cgImage: image)

        // Normalized top-left-origin points → CI's bottom-left-origin pixels.
        func point(_ p: CGPoint) -> CGPoint {
            CGPoint(x: p.x * width, y: (1 - p.y) * height)
        }

        let filter = CIFilter.perspectiveCorrection()
        filter.inputImage = ciImage
        filter.topLeft = point(corners[0])
        filter.topRight = point(corners[1])
        filter.bottomRight = point(corners[2])
        filter.bottomLeft = point(corners[3])
        guard let corrected = filter.outputImage else { return nil }

        // Scale the corrected quad to the fixed square the detector reads.
        let extent = corrected.extent
        guard extent.width > 1, extent.height > 1 else { return nil }
        let side = CGFloat(Self.outputSide)
        let scaled = corrected
            .transformed(by: CGAffineTransform(translationX: -extent.origin.x, y: -extent.origin.y))
            .transformed(by: CGAffineTransform(scaleX: side / extent.width, y: side / extent.height))
        return context.createCGImage(scaled, from: CGRect(x: 0, y: 0, width: side, height: side))
    }
}
