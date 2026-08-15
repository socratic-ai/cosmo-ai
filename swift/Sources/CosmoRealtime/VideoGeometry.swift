import CoreGraphics

/// How a video frame is fitted into the view showing it — the same two
/// choices `AVLayerVideoGravity` and SwiftUI's `ContentMode` offer.
public enum VideoContentMode: Sendable, Equatable {
    /// Whole frame visible, letterboxed where the aspect ratios differ
    /// (`resizeAspect` / `.fit`).
    case fit
    /// Frame fills the view, cropped symmetrically on the long axis
    /// (`resizeAspectFill` / `.fill`).
    case fill
}

/// Where a normalized frame lands inside a container under a content mode:
/// the drawn size and the (possibly negative, when cropping) origin offset.
private func placement(
    container: CGSize, frameSize: CGSize, contentMode: VideoContentMode
) -> (size: CGSize, offset: CGPoint)? {
    guard frameSize.width > 0, frameSize.height > 0,
          container.width > 0, container.height > 0
    else { return nil }
    let widthRatio = container.width / frameSize.width
    let heightRatio = container.height / frameSize.height
    let scale = contentMode == .fill
        ? max(widthRatio, heightRatio)
        : min(widthRatio, heightRatio)
    let size = CGSize(width: frameSize.width * scale, height: frameSize.height * scale)
    return (size, CGPoint(
        x: (container.width - size.width) / 2,
        y: (container.height - size.height) / 2
    ))
}

extension NormalizedBox {
    /// Where to draw this box inside a view showing the frame it was measured
    /// against.
    ///
    /// The model reports coordinates against **the frame it was shown**, which
    /// is rarely what the viewer sees pixel-for-pixel: the view crops (`.fill`)
    /// or letterboxes (`.fit`), and a front-camera preview is mirrored while
    /// the published frame never is. Both corrections live here so every
    /// surface applies them identically.
    ///
    /// Returns `.zero` for a degenerate frame or container.
    public func rect(
        in container: CGSize,
        frameSize: CGSize,
        contentMode: VideoContentMode = .fill,
        mirrored: Bool = false
    ) -> CGRect {
        guard let (size, offset) = placement(
            container: container, frameSize: frameSize, contentMode: contentMode
        ) else { return .zero }
        var rect = CGRect(
            x: offset.x + x * size.width,
            y: offset.y + y * size.height,
            width: width * size.width,
            height: height * size.height
        )
        if mirrored { rect.origin.x = container.width - rect.maxX }
        return rect
    }
}

extension NormalizedPoint {
    /// Where to mark this point inside a view showing the frame it was
    /// measured against. Same corrections as ``NormalizedBox/rect(in:frameSize:contentMode:mirrored:)``.
    ///
    /// Returns `.zero` for a degenerate frame or container.
    public func point(
        in container: CGSize,
        frameSize: CGSize,
        contentMode: VideoContentMode = .fill,
        mirrored: Bool = false
    ) -> CGPoint {
        guard let (size, offset) = placement(
            container: container, frameSize: frameSize, contentMode: contentMode
        ) else { return .zero }
        let mapped = CGPoint(
            x: offset.x + x * size.width,
            y: offset.y + y * size.height
        )
        return mirrored ? CGPoint(x: container.width - mapped.x, y: mapped.y) : mapped
    }
}
