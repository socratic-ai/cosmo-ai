import CoreGraphics

/// A source of on-demand camera stills for the single-frame Vision tools — the
/// real form of the `camera` the tool dispatcher's contract references. A still is
/// an **upright `CGImage`** ready to pass straight to `VisionToolDispatcher.run`;
/// `nil` when the camera is off or no frame is available yet.
///
/// The capture-owning backend implements it (e.g. the ARKit face-tracking source),
/// so an app's client-tool handler codes against this protocol and stays
/// independent of which camera is running — the still-capture analog of how
/// `FaceGeometrySource` abstracts the tracking backends.
@MainActor
public protocol CameraStillProviding {
    func currentFrame() -> CGImage?
}
