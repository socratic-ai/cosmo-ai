import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Resize a `CGImage` to a maximum long edge and JPEG-encode it for
/// ``RealtimeSession/send(image:maxLongEdge:quality:streamId:)``.
///
/// ## Why 1280
///
/// Both providers normalize a frame before they look at it, so pixels above
/// their working resolution are discarded — they buy no comprehension and cost
/// bandwidth, chunking round-trips, and base64's 4/3 inflation.
///
/// - Gemini Live spends a fixed token budget per frame set by the session's
///   media resolution, not by the frame's pixel count. Sending more pixels does
///   not change what it costs or what the model sees.
/// - OpenAI's tile-based vision path fits the image into 2048x2048, then scales
///   the *shortest* side to 768. On a 16:10 screen that lands at a working long
///   edge near 1200px; anything beyond is dropped before tokenization.
///
/// 1280 sits just above the point where extra pixels stop doing anything on
/// either provider. It is a ceiling on waste, not a quality target — pass a
/// larger `maxLongEdge` when a task genuinely needs the detail (dense OCR,
/// fine-grained UI grounding) and you have measured that it helps.
public enum ImageDownscale {
    /// Default ceiling for frames sent over the realtime control channel.
    public static let recommendedMaxLongEdge = 1280

    /// Default JPEG quality. Matches the ceiling's intent: visually clean at
    /// screen-capture scale without paying for imperceptible detail.
    public static let recommendedQuality = 0.8

    /// Consumers only ever receive one of these, so there is no public
    /// memberwise init to keep compatible.
    public struct Encoded: Sendable, Equatable {
        public let base64: String
        public let mimeType: String
        public let width: Int
        public let height: Int
    }

    public enum Error: Swift.Error, CustomStringConvertible, LocalizedError, Equatable {
        case invalidLongEdge(Int)
        case invalidQuality(Double)
        case resizeFailed
        case encodeFailed
        case undecodable
        case payloadTooLarge(base64Length: Int, limit: Int, recommendedLongEdge: Int)

        public var description: String {
            switch self {
            case .invalidLongEdge(let v): return "long-edge must be > 0 (got \(v))"
            case .invalidQuality(let v): return "JPEG quality must be in 0...1 (got \(v))"
            case .resizeFailed: return "failed to redraw CGImage at the target size"
            case .encodeFailed: return "CGImageDestination failed to encode JPEG"
            case .undecodable: return "payload is not base64-encoded image data this platform can decode"
            case .payloadTooLarge(let length, let limit, let edge):
                return """
                    image payload is \(length) base64 chars, over the \(limit) limit, \
                    and could not be downscaled — encode it at \(edge)px long edge
                    """
            }
        }

        public var errorDescription: String? { description }
    }

    /// Target `(width, height)` for an image of size `(width, height)` such that
    /// the longer edge is `<= maxLongEdge` and the aspect ratio is preserved.
    /// Never upscales — a source that already fits is returned unchanged.
    ///
    /// Internal: a math helper with a degenerate-input contract (non-positive
    /// dimensions clamp rather than throw) that isn't worth freezing into the
    /// published surface.
    static func targetSize(
        width: Int,
        height: Int,
        maxLongEdge: Int
    ) throws -> (width: Int, height: Int) {
        guard maxLongEdge > 0 else { throw Error.invalidLongEdge(maxLongEdge) }
        guard width > 0, height > 0 else { return (max(width, 1), max(height, 1)) }
        let longEdge = max(width, height)
        if longEdge <= maxLongEdge { return (width, height) }
        let scale = Double(maxLongEdge) / Double(longEdge)
        let w = max(1, Int((Double(width) * scale).rounded()))
        let h = max(1, Int((Double(height) * scale).rounded()))
        return (w, h)
    }

    /// Resize `image` (if needed) so its long edge is at most `maxLongEdge`,
    /// JPEG-encode at `quality`, and return base64 plus the final dimensions.
    public static func encodeJPEG(
        image: CGImage,
        maxLongEdge: Int = recommendedMaxLongEdge,
        quality: Double = recommendedQuality
    ) throws -> Encoded {
        guard maxLongEdge > 0 else { throw Error.invalidLongEdge(maxLongEdge) }
        guard (0.0...1.0).contains(quality) else { throw Error.invalidQuality(quality) }

        // autoreleasepool: CGContext / CGImage / CGImageDestination are
        // CFTypeRefs bridged to ObjC. Swift's cooperative task pool doesn't
        // drain autorelease pools, so without this they accumulate across
        // repeated captures and grow RSS until the queue idles.
        return try autoreleasepool {
            let target = try targetSize(
                width: image.width,
                height: image.height,
                maxLongEdge: maxLongEdge
            )

            let resized: CGImage
            if target.width == image.width, target.height == image.height {
                resized = image
            } else {
                guard let redrawn = redraw(image: image, to: target) else {
                    throw Error.resizeFailed
                }
                resized = redrawn
            }

            let data = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(
                data,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            ) else {
                throw Error.encodeFailed
            }
            let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
            CGImageDestinationAddImage(dest, resized, opts as CFDictionary)
            guard CGImageDestinationFinalize(dest) else {
                throw Error.encodeFailed
            }
            let bytes = data as Data
            return Encoded(
                base64: bytes.base64EncodedString(),
                mimeType: "image/jpeg",
                width: resized.width,
                height: resized.height
            )
        }
    }

    /// Re-encode an already-base64'd image so its long edge is at most
    /// `maxLongEdge`. Returns `nil` when the source already fits — the caller
    /// should then send what it was given rather than pay a lossy round trip.
    ///
    /// Decoding a frame the caller already encoded is not free, which is why
    /// this is reserved for payloads that are demonstrably oversized. Prefer
    /// ``encodeJPEG(image:maxLongEdge:quality:)`` and never encode twice.
    public static func downscaleBase64(
        _ base64: String,
        maxLongEdge: Int = recommendedMaxLongEdge,
        quality: Double = recommendedQuality
    ) throws -> Encoded? {
        guard maxLongEdge > 0 else { throw Error.invalidLongEdge(maxLongEdge) }
        guard let data = Data(base64Encoded: base64) else { throw Error.undecodable }
        return try autoreleasepool {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                throw Error.undecodable
            }
            // Dimensions come from the header, so a frame that already fits
            // never decodes its pixels — the common case for a large payload
            // is a heavy encode at an acceptable resolution. Orientation is
            // irrelevant to this test: a rotated image swaps width and height,
            // and the long edge is the same either way.
            guard let size = pixelSize(source: source) else { throw Error.undecodable }
            guard max(size.width, size.height) > maxLongEdge else { return nil }

            // Downsample during decode rather than materializing the
            // full-resolution bitmap: a payload near the send limit is ~9 MB of
            // JPEG, which is hundreds of MB decoded. `WithTransform` bakes in
            // the EXIF orientation, which a plain re-encode would silently drop
            // — the frames that reach this path are usually camera photos.
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxLongEdge,
            ]
            guard
                let thumbnail = CGImageSourceCreateThumbnailAtIndex(
                    source, 0, options as CFDictionary
                )
            else {
                throw Error.undecodable
            }
            return try encodeJPEG(image: thumbnail, maxLongEdge: maxLongEdge, quality: quality)
        }
    }

    private static func pixelSize(source: CGImageSource) -> (width: Int, height: Int)? {
        guard
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = props[kCGImagePropertyPixelWidth] as? Int,
            let height = props[kCGImagePropertyPixelHeight] as? Int
        else {
            return nil
        }
        return (width, height)
    }

    private static func redraw(image: CGImage, to size: (width: Int, height: Int)) -> CGImage? {
        let colorSpace = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        var bitmapInfo = image.bitmapInfo.rawValue
        let alpha = CGImageAlphaInfo(rawValue: bitmapInfo & CGBitmapInfo.alphaInfoMask.rawValue)
        switch alpha {
        case .some(.none), .some(.alphaOnly), Optional<CGImageAlphaInfo>.none:
            bitmapInfo = (bitmapInfo & ~CGBitmapInfo.alphaInfoMask.rawValue)
                | CGImageAlphaInfo.noneSkipLast.rawValue
        default:
            break
        }
        guard let ctx = CGContext(
            data: nil,
            width: size.width,
            height: size.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            return nil
        }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        return ctx.makeImage()
    }
}
