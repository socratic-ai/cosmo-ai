import AVFoundation
import SwiftUI

struct ContentView: View {
    @StateObject private var loop = PerceptionLoop()
    @State private var apiKey =
        ProcessInfo.processInfo.environment["COSMO_API_KEY"]
        ?? UserDefaults.standard.string(forKey: "cosmo_api_key")
        ?? ""
    @State private var calibrating = false
    @State private var tappedCorners: [CGPoint] = []
    @State private var previewSize: CGSize = .zero

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                CameraPreview(session: loop.camera.session)
                    .overlay(alignment: .topLeading) { statusOverlay }
                if calibrating { calibrationOverlay }
            }
            .aspectRatio(3 / 4, contentMode: .fit)
            .clipped()
            .contentShape(Rectangle())
            .background(
                GeometryReader { geometry in
                    Color.clear.onAppear { previewSize = geometry.size }
                        .onChange(of: geometry.size) { _, size in previewSize = size }
                }
            )
            .onTapGesture { location in
                guard calibrating, previewSize.width > 0, previewSize.height > 0 else { return }
                recordCorner(
                    at: CGPoint(
                        x: location.x / previewSize.width,
                        y: location.y / previewSize.height
                    )
                )
            }

            controls
            transcriptList
        }
        .task {
            await loop.camera.start()
            loop.start()
        }
    }

    // MARK: - Overlays

    private var statusOverlay: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !loop.lastPlacement.isEmpty {
                Text(loop.lastPlacement)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
            }
            if !loop.session.lastVerdict.isEmpty {
                Text(loop.session.lastVerdict)
                    .font(.caption.bold())
                    .foregroundStyle(
                        loop.session.lastVerdict.hasPrefix("ILLEGAL") ? .red : .primary
                    )
            }
            if let error = loop.detectorError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
        .padding(8)
    }

    private var calibrationOverlay: some View {
        GeometryReader { geometry in
            ZStack {
                ForEach(Array(tappedCorners.enumerated()), id: \.offset) { index, corner in
                    Circle()
                        .fill(.orange)
                        .frame(width: 22, height: 22)
                        .overlay(Text("\(index + 1)").font(.caption2.bold()))
                        .position(
                            x: corner.x * geometry.size.width,
                            y: corner.y * geometry.size.height
                        )
                }
                VStack {
                    Spacer()
                    Text(calibrationPrompt)
                        .font(.callout.bold())
                        .padding(10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.bottom, 12)
                }
            }
        }
    }

    private var calibrationPrompt: String {
        let names = ["top-left", "top-right", "bottom-right", "bottom-left"]
        return tappedCorners.count < 4
            ? "Tap the board's \(names[tappedCorners.count]) corner"
            : "Calibrated"
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 10) {
            HStack {
                Button(calibrating ? "Cancel" : "Calibrate board") {
                    calibrating.toggle()
                    tappedCorners = []
                    if !calibrating { loop.rectifier = nil }
                }
                .buttonStyle(.bordered)

                Button("New game") { loop.referee.startNewGame() }
                    .buttonStyle(.bordered)

                Spacer()
                connectButton
            }
            if case .idle = loop.session.phase {
                SecureField("Cosmo API key (or set COSMO_API_KEY)", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    @ViewBuilder private var connectButton: some View {
        switch loop.session.phase {
        case .idle:
            Button("Connect") {
                UserDefaults.standard.set(apiKey, forKey: "cosmo_api_key")
                Task { await loop.session.connect(apiKey: apiKey) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(apiKey.isEmpty)
        case .connecting:
            ProgressView()
        case .live:
            Button("End") { Task { await loop.session.end() } }
                .buttonStyle(.borderedProminent)
                .tint(.red)
        case .ended(let reason), .failed(let reason):
            VStack(alignment: .trailing) {
                Text(reason).font(.caption2).lineLimit(1)
                Button("Reconnect") { loop.session.phase = .idle }
                    .buttonStyle(.bordered)
            }
        }
    }

    private var transcriptList: some View {
        ScrollViewReader { proxy in
            List(loop.session.transcript) { line in
                HStack(alignment: .top) {
                    Text(line.role == "user" ? "you" : "ref")
                        .font(.caption2.bold())
                        .foregroundStyle(line.role == "user" ? .secondary : Color.orange)
                        .frame(width: 30, alignment: .leading)
                    Text(line.text)
                        .font(.callout)
                        .opacity(line.isFinal ? 1 : 0.6)
                }
                .id(line.id)
            }
            .listStyle(.plain)
            .onChange(of: loop.session.transcript) { _, lines in
                if let last = lines.last { proxy.scrollTo(last.id) }
            }
        }
    }

    // MARK: - Calibration

    private func recordCorner(at normalized: CGPoint) {
        // Normalized against the preview, which shows the frame aspect-fit;
        // good enough for a demo where the preview matches the frame's aspect.
        tappedCorners.append(normalized)
        if tappedCorners.count == 4 {
            loop.rectifier = BoardRectifier(corners: tappedCorners)
            calibrating = false
        }
    }
}

/// UIKit bridge for the AVCaptureSession preview.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}
