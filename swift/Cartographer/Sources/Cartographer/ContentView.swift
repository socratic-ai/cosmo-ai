import SwiftUI
import AppKit

struct ContentView: View {
    @StateObject private var map = MindMap()
    @StateObject private var conductor: Conductor
    @State private var pulse = false
    @State private var typed = ""

    init() {
        let map = MindMap()
        _map = StateObject(wrappedValue: map)
        _conductor = StateObject(wrappedValue: Conductor(map: map))
    }

    var body: some View {
        HStack(spacing: 0) {
            canvasPane
            Divider().overlay(Color.white.opacity(0.08))
            sidePane.frame(width: 300)
        }
        .background(Color(red: 0.07, green: 0.075, blue: 0.09))
        .preferredColorScheme(.dark)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                pulse = true
            }
            // Self-driving mode, for verifying the pipeline without a mic.
            let env = ProcessInfo.processInfo.environment
            if env["CARTO_AUTOSTART"] == "1" {
                Task {
                    await conductor.start()
                    if let seed = env["CARTO_SEED"] {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        await conductor.say(seed)
                    }
                }
            }
        }
    }

    // MARK: Canvas

    private var canvasPane: some View {
        ZStack {
            RadialGradient(
                colors: [Color(red: 0.13, green: 0.14, blue: 0.19), Color(red: 0.06, green: 0.065, blue: 0.08)],
                center: .center, startRadius: 40, endRadius: 640
            )

            if conductor.map.isEmpty {
                emptyState
            } else {
                MapCanvas(map: conductor.map, pulse: pulse)
                    .padding(28)
            }

            VStack {
                header
                Spacer()
                controls
            }
            .padding(20)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(conductor.map.title)
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.92))
                Text("\(conductor.map.nodes.count) ideas · \(conductor.map.links.count) links")
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(.white.opacity(0.38))
            }
            Spacer()
            statusPill
        }
    }

    private var statusPill: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .scaleEffect(conductor.youSpeaking || conductor.agentSpeaking ? (pulse ? 1.5 : 1.0) : 1)
            Text(conductor.status.caption)
                .font(.system(size: 11.5, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color.white.opacity(0.06)))
    }

    private var statusColor: Color {
        switch conductor.status {
        case .idle:       return .gray
        case .connecting: return .yellow
        case .live:       return conductor.agentSpeaking ? .cyan : .green
        case .ended:      return .gray
        case .failed:     return .red
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("Think out loud.")
                .font(.system(size: 26, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.8))
            Text("The map draws itself while you talk.")
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(.white.opacity(0.35))
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            switch conductor.status {
            case .idle, .ended, .failed:
                Button {
                    Task { await conductor.start() }
                } label: {
                    Label("Open the map", systemImage: "mic.fill")
                        .font(.system(size: 12.5, weight: .medium, design: .rounded))
                        .padding(.horizontal, 6).padding(.vertical, 3)
                }
                .buttonStyle(.borderedProminent)
                .tint(.indigo)
            case .connecting:
                ProgressView().controlSize(.small)
            case .live:
                Button {
                    Task { await conductor.toggleMute() }
                } label: {
                    Label(
                        conductor.muted ? "Unmute" : "Mute",
                        systemImage: conductor.muted ? "mic.slash.fill" : "mic.fill"
                    )
                    .font(.system(size: 12.5, design: .rounded))
                }
                Button("Finish") { Task { await conductor.stop() } }
                    .font(.system(size: 12.5, design: .rounded))
            }

            Spacer()

            if !conductor.map.isEmpty {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(conductor.map.markdown(), forType: .string)
                } label: {
                    Label("Copy as Markdown", systemImage: "doc.on.doc")
                        .font(.system(size: 12, design: .rounded))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.45))
            }
        }
    }

    // MARK: Side pane

    private var sidePane: some View {
        VStack(spacing: 0) {
            transcript
            Divider().overlay(Color.white.opacity(0.08))
            toolFeed
            typeBar
        }
        .background(Color(red: 0.055, green: 0.06, blue: 0.075))
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 9) {
                    ForEach(conductor.lines) { line in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line.speaker.rawValue)
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(color(for: line.speaker).opacity(0.7))
                            Text(line.text)
                                .font(.system(size: 12, design: .rounded))
                                .foregroundStyle(
                                    line.speaker == .system
                                        ? .white.opacity(0.3)
                                        : .white.opacity(line.isFinal ? 0.82 : 0.5)
                                )
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id(line.id)
                    }
                }
                .padding(14)
            }
            .onChange(of: conductor.lines.count) {
                if let last = conductor.lines.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private func color(for speaker: Conductor.Line.Speaker) -> Color {
        switch speaker {
        case .you:    return .green
        case .cosmo:  return .cyan
        case .system: return .gray
        }
    }

    private var toolFeed: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(conductor.toolFeed.enumerated()), id: \.offset) { _, entry in
                    Text(entry)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.42))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .frame(height: 116)
        .defaultScrollAnchor(.bottom)
    }

    private var typeBar: some View {
        HStack(spacing: 6) {
            TextField("or type…", text: $typed)
                .textFieldStyle(.plain)
                .font(.system(size: 12, design: .rounded))
                .onSubmit {
                    let text = typed
                    typed = ""
                    Task { await conductor.say(text) }
                }
            Image(systemName: "return")
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.25))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Color.white.opacity(0.04))
    }
}
