import Foundation

/// Head orientation in degrees, as a face-tracking backend reports it.
public struct FacePose: Sendable, Equatable {
    public var rollDegrees: Double
    public var yawDegrees: Double
    public var pitchDegrees: Double

    public init(rollDegrees: Double, yawDegrees: Double, pitchDegrees: Double) {
        self.rollDegrees = rollDegrees
        self.yawDegrees = yawDegrees
        self.pitchDegrees = pitchDegrees
    }
}

/// A normalized snapshot of the user's face for one frame — the shared output of
/// every face-tracking backend (the Vision per-frame baseline, the ARKit mesh
/// upgrade). All geometry is normalized `[0,1]`, top-left origin (the SDK
/// convention); never pixels. A consumer (an overlay) maps it onto the preview.
public struct FaceGeometry: Sendable, Equatable {
    /// Feature outlines as ordered points (eyes, brows, lips, …) — trace these.
    public var contours: [String: [NormalizedPoint]]
    /// Feature boxes (cheeks, forehead, …) — highlight these.
    public var regions: [String: NormalizedBox]
    /// Head orientation, when the backend provides it.
    public var pose: FacePose?
    /// Camera-to-face distance in meters, when the backend provides depth
    /// (e.g. ARKit / TrueDepth); `nil` for backends that don't measure it.
    public var distanceMeters: Double?

    public init(
        contours: [String: [NormalizedPoint]] = [:],
        regions: [String: NormalizedBox] = [:],
        pose: FacePose? = nil,
        distanceMeters: Double? = nil
    ) {
        self.contours = contours
        self.regions = regions
        self.pose = pose
        self.distanceMeters = distanceMeters
    }

    /// No face geometry resolved this frame (no contours, regions, pose, or distance).
    public var isEmpty: Bool {
        contours.isEmpty && regions.isEmpty && pose == nil && distanceMeters == nil
    }
}

/// A live source of face geometry — emits one `FaceGeometry?` per processed frame
/// (`nil` = no face that frame). Two backends implement it: `VisionFaceGeometrySource`
/// (every device, the baseline) and the ARKit mesh source (TrueDepth upgrade). A
/// consumer subscribes to `geometry`; `start()` / `stop()` bound processing.
/// Capture ownership is backend-specific: the Vision baseline is fed by an
/// external camera (`FrameSource`) the owner drives, while the ARKit source owns
/// its own `ARSession` — so `start()` / `stop()` may also start/stop capture.
@MainActor
public protocol FaceGeometrySource: AnyObject {
    /// Single-consumer stream of the latest geometry — one overlay subscribes.
    var geometry: AsyncStream<FaceGeometry?> { get }
    /// Begin processing frames. Single-use: after `stop()` this is a no-op — make
    /// a fresh source per screen appearance.
    func start()
    /// Stop processing and finish `geometry`. Terminal.
    func stop()
}
