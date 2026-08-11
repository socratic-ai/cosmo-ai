import AVFoundation
import CoreImage
import CoreGraphics

/// Back-camera capture that keeps the latest frame available as a CGImage.
/// The detection loop pulls frames at its own cadence; capture never blocks
/// on inference.
final class CameraController: NSObject, ObservableObject,
    AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "chessreferee.camera")
    private let ciContext = CIContext()
    private let latestLock = NSLock()
    private var latestFrame: CGImage?

    @Published var authorized = false

    func start() async {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        await MainActor.run { authorized = granted }
        guard granted else { return }

        queue.async { [self] in
            guard session.inputs.isEmpty else {
                if !session.isRunning { session.startRunning() }
                return
            }
            session.beginConfiguration()
            session.sessionPreset = .hd1280x720
            // Prefer the multi-lens virtual device: iOS then auto-switches to
            // the ultra-wide for close focus when the phone hangs low over a
            // board — the plain wide lens can't focus under ~20cm.
            let device = AVCaptureDevice.default(.builtInTripleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInDualWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            if let device, let input = try? AVCaptureDeviceInput(device: device),
               session.canAddInput(input) {
                session.addInput(input)
            }
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(output) { session.addOutput(output) }
            if let connection = output.connection(with: .video),
               connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
            session.commitConfiguration()
            session.startRunning()
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    /// The most recent camera frame, or nil before the first frame lands.
    func currentFrame() -> CGImage? {
        latestLock.lock()
        defer { latestLock.unlock() }
        return latestFrame
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }
        latestLock.lock()
        latestFrame = cgImage
        latestLock.unlock()
    }
}
