import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation
import Testing
@testable import CosmoRealtime

@Suite("ImageDownscale")
struct ImageDownscaleTests {

    private func solidImage(width: Int, height: Int) throws -> CGImage {
        let ctx = try #require(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            )
        )
        ctx.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try #require(ctx.makeImage())
    }

    /// JPEG carrying an explicit EXIF orientation tag, which `encodeJPEG` does
    /// not write.
    private func jpegBase64(image: CGImage, orientation: Int) throws -> String {
        let data = NSMutableData()
        let dest = try #require(
            CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        )
        CGImageDestinationAddImage(
            dest,
            image,
            [
                kCGImageDestinationLossyCompressionQuality: 0.9,
                kCGImagePropertyOrientation: orientation,
            ] as CFDictionary
        )
        #expect(CGImageDestinationFinalize(dest))
        return (data as Data).base64EncodedString()
    }

    @Test("targetSize caps the long edge and preserves aspect ratio")
    func targetSizeCaps() throws {
        let size = try ImageDownscale.targetSize(width: 2704, height: 1756, maxLongEdge: 1280)
        #expect(size.width == 1280)
        // 1756 * (1280/2704) = 831.4…
        #expect(size.height == 831)
    }

    @Test("targetSize caps the long edge on portrait sources too")
    func targetSizePortrait() throws {
        let size = try ImageDownscale.targetSize(width: 1000, height: 4000, maxLongEdge: 1280)
        #expect(size.height == 1280)
        #expect(size.width == 320)
    }

    @Test("targetSize never upscales a source that already fits")
    func targetSizeNeverUpscales() throws {
        let size = try ImageDownscale.targetSize(width: 640, height: 400, maxLongEdge: 1280)
        #expect(size.width == 640)
        #expect(size.height == 400)
    }

    @Test("targetSize rejects a non-positive long edge")
    func targetSizeRejectsBadEdge() throws {
        #expect(throws: ImageDownscale.Error.invalidLongEdge(0)) {
            try ImageDownscale.targetSize(width: 100, height: 100, maxLongEdge: 0)
        }
    }

    @Test("encodeJPEG bounds the long edge to the recommended default")
    func encodeJPEGBounds() throws {
        let encoded = try ImageDownscale.encodeJPEG(image: try solidImage(width: 3000, height: 2000))
        #expect(encoded.width == ImageDownscale.recommendedMaxLongEdge)
        #expect(encoded.mimeType == "image/jpeg")
        #expect(!encoded.base64.isEmpty)
    }

    @Test("encodeJPEG rejects a quality outside 0...1")
    func encodeJPEGRejectsQuality() throws {
        let image = try solidImage(width: 64, height: 64)
        #expect(throws: ImageDownscale.Error.invalidQuality(1.5)) {
            try ImageDownscale.encodeJPEG(image: image, quality: 1.5)
        }
    }

    @Test("downscaleBase64 re-encodes an oversized frame")
    func downscaleBase64Shrinks() throws {
        let original = try ImageDownscale.encodeJPEG(
            image: try solidImage(width: 2600, height: 1600),
            maxLongEdge: 2600
        )
        let bounded = try #require(try ImageDownscale.downscaleBase64(original.base64))
        #expect(bounded.width == ImageDownscale.recommendedMaxLongEdge)
        #expect(bounded.base64.count < original.base64.count)
    }

    @Test("downscaleBase64 returns nil when the source already fits")
    func downscaleBase64PassesThrough() throws {
        let original = try ImageDownscale.encodeJPEG(image: try solidImage(width: 800, height: 600))
        #expect(try ImageDownscale.downscaleBase64(original.base64) == nil)
    }

    /// A plain `CGImageSourceCreateImageAtIndex` re-encode drops the EXIF
    /// orientation tag, so a portrait camera photo — the exact payload that
    /// triggers this path — would reach the model rotated.
    @Test("downscaleBase64 bakes in EXIF orientation instead of dropping it")
    func downscaleBase64AppliesOrientation() throws {
        // Orientation 6 = rotated 90°: stored 2000x1000, displays as 1000x2000.
        let rotated = try jpegBase64(
            image: try solidImage(width: 2000, height: 1000),
            orientation: 6
        )
        let bounded = try #require(try ImageDownscale.downscaleBase64(rotated))
        // Applying the transform makes the display orientation the real one,
        // so the tall edge must come back as the height.
        #expect(bounded.height > bounded.width)
        #expect(max(bounded.width, bounded.height) == ImageDownscale.recommendedMaxLongEdge)
    }

    @Test("downscaleBase64 rejects a non-positive long edge")
    func downscaleBase64RejectsBadEdge() throws {
        let encoded = try ImageDownscale.encodeJPEG(image: try solidImage(width: 64, height: 64))
        #expect(throws: ImageDownscale.Error.invalidLongEdge(0)) {
            try ImageDownscale.downscaleBase64(encoded.base64, maxLongEdge: 0)
        }
    }

    @Test("downscaleBase64 rejects payloads that are not decodable images")
    func downscaleBase64Undecodable() throws {
        #expect(throws: ImageDownscale.Error.undecodable) {
            try ImageDownscale.downscaleBase64("bm90IGFuIGltYWdl")
        }
    }
}
