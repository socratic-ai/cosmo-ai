import SwiftUI

/// The map itself. Nodes are laid out in unit space by `MindMap.layout()`
/// and projected onto whatever size the window gives us.
struct MapCanvas: View {
    @ObservedObject var map: MindMap
    var pulse: Bool

    var body: some View {
        GeometryReader { geo in
            let scale = min(geo.size.width, geo.size.height) * 0.82
            let origin = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)

            ZStack {
                ForEach(map.nodes) { node in
                    if let parent = map.nodes.first(where: { $0.id == node.parent }) {
                        Branch(
                            from: project(parent.point, origin, scale),
                            to: project(node.point, origin, scale)
                        )
                        .stroke(
                            Color.white.opacity(0.16),
                            style: StrokeStyle(lineWidth: 1.4, lineCap: .round)
                        )
                    }
                }

                ForEach(map.links) { link in
                    if let a = map.nodes.first(where: { $0.id == link.from }),
                       let b = map.nodes.first(where: { $0.id == link.to }) {
                        Branch(
                            from: project(a.point, origin, scale),
                            to: project(b.point, origin, scale)
                        )
                        .stroke(
                            Color.orange.opacity(0.5),
                            style: StrokeStyle(lineWidth: 1, dash: [4, 5])
                        )
                    }
                }

                ForEach(map.nodes) { node in
                    NodeChip(
                        node: node,
                        isSpotlit: map.spotlit == node.id,
                        pulse: pulse
                    )
                    .position(project(node.point, origin, scale))
                }
            }
            .animation(.spring(response: 0.55, dampingFraction: 0.78), value: map.nodes)
            .animation(.easeOut(duration: 0.3), value: map.spotlit)
        }
    }

    private func project(_ p: CGPoint, _ origin: CGPoint, _ scale: CGFloat) -> CGPoint {
        CGPoint(x: origin.x + p.x * scale, y: origin.y + p.y * scale)
    }
}

private struct Branch: Shape {
    var from: CGPoint
    var to: CGPoint

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>> {
        get { .init(.init(from.x, from.y), .init(to.x, to.y)) }
        set {
            from = CGPoint(x: newValue.first.first, y: newValue.first.second)
            to = CGPoint(x: newValue.second.first, y: newValue.second.second)
        }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: from)
        // A slight bow reads as organic rather than as a wiring diagram.
        let mid = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
        let normal = CGPoint(x: -(to.y - from.y), y: to.x - from.x)
        let len = max(sqrt(normal.x * normal.x + normal.y * normal.y), 0.001)
        let bow = CGPoint(
            x: mid.x + normal.x / len * 12,
            y: mid.y + normal.y / len * 12
        )
        p.addQuadCurve(to: to, control: bow)
        return p
    }
}

private struct NodeChip: View {
    let node: MapNode
    let isSpotlit: Bool
    let pulse: Bool

    private var tint: Color {
        let palette: [Color] = [
            Color(red: 0.98, green: 0.85, blue: 0.42),
            Color(red: 0.53, green: 0.83, blue: 0.98),
            Color(red: 0.72, green: 0.94, blue: 0.66),
            Color(red: 0.96, green: 0.68, blue: 0.79),
            Color(red: 0.80, green: 0.75, blue: 0.99),
        ]
        return palette[node.depth % palette.count]
    }

    var body: some View {
        Text(node.label)
            .font(.system(size: node.depth == 0 ? 15 : 12.5, weight: node.depth == 0 ? .semibold : .medium, design: .rounded))
            .foregroundStyle(Color.black.opacity(0.82))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 132)
            .padding(.horizontal, 11)
            .padding(.vertical, 6.5)
            .background(
                Capsule(style: .continuous)
                    .fill(tint.opacity(isSpotlit ? 1 : 0.82))
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(Color.white.opacity(isSpotlit ? 0.9 : 0), lineWidth: 1.5)
            )
            .shadow(
                color: tint.opacity(isSpotlit && pulse ? 0.75 : 0.25),
                radius: isSpotlit && pulse ? 18 : 6
            )
            .scaleEffect(isSpotlit ? 1.06 : 1)
            .transition(.scale(scale: 0.4).combined(with: .opacity))
    }
}
