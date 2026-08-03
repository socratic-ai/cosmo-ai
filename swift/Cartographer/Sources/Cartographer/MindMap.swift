import Foundation
import SwiftUI

/// One idea on the map.
struct MapNode: Identifiable, Equatable {
    let id: String
    var label: String
    var parent: String?
    var depth: Int
    var born: Date
    /// Position in unit space, resolved by `MindMap.layout()`.
    var point: CGPoint = .zero
}

/// A non-tree association the agent drew between two ideas.
struct MapLink: Identifiable, Equatable {
    let id = UUID()
    let from: String
    let to: String
    var relation: String
}

/// The live map. Mutated only from the main actor; the SwiftUI canvas
/// re-lays-out on every change so nodes slide into place as they arrive.
@MainActor
final class MindMap: ObservableObject {
    @Published private(set) var nodes: [MapNode] = []
    @Published private(set) var links: [MapLink] = []
    @Published var title: String = "Untitled map"
    @Published var spotlit: String?

    var isEmpty: Bool { nodes.isEmpty }

    /// Resolve a model-supplied reference — it may hand back an id we
    /// minted, or just re-say the label. Both must land on the same node.
    func resolve(_ ref: String) -> MapNode? {
        let needle = Self.slug(ref)
        if let hit = nodes.first(where: { $0.id == needle }) { return hit }
        return nodes.first { Self.slug($0.label) == needle }
    }

    @discardableResult
    func add(label: String, parentRef: String?) -> MapNode {
        let parent = parentRef.flatMap { resolve($0) }
        var id = Self.slug(label)
        var bump = 2
        while nodes.contains(where: { $0.id == id }) {
            id = "\(Self.slug(label))-\(bump)"
            bump += 1
        }
        let node = MapNode(
            id: id,
            label: label,
            parent: parent?.id,
            depth: (parent?.depth ?? -1) + 1,
            born: Date()
        )
        nodes.append(node)
        spotlit = id
        layout()
        return node
    }

    func link(from: String, to: String, relation: String) -> Bool {
        guard let a = resolve(from), let b = resolve(to), a.id != b.id else { return false }
        guard !links.contains(where: { $0.from == a.id && $0.to == b.id }) else { return false }
        links.append(MapLink(from: a.id, to: b.id, relation: relation))
        return true
    }

    func spotlight(_ ref: String) -> MapNode? {
        guard let node = resolve(ref) else { return nil }
        spotlit = node.id
        return node
    }

    func reset() {
        nodes = []
        links = []
        spotlit = nil
        title = "Untitled map"
    }

    /// A plain-text rendering the agent can read back to reason about what
    /// is already on screen.
    func outline() -> String {
        guard !nodes.isEmpty else { return "(the map is empty)" }
        var out: [String] = []
        func walk(_ parent: String?, _ indent: String) {
            for node in nodes.filter({ $0.parent == parent }) {
                out.append("\(indent)- \(node.label) [id: \(node.id)]")
                walk(node.id, indent + "  ")
            }
        }
        walk(nil, "")
        for link in links {
            out.append("* \(link.from) --\(link.relation)--> \(link.to)")
        }
        return out.joined(separator: "\n")
    }

    func markdown() -> String {
        var out = ["# \(title)", ""]
        func walk(_ parent: String?, _ level: Int) {
            for node in nodes.filter({ $0.parent == parent }) {
                out.append("\(String(repeating: "  ", count: level))- \(node.label)")
                walk(node.id, level + 1)
            }
        }
        walk(nil, 0)
        if !links.isEmpty {
            out.append("")
            out.append("## Connections")
            for link in links {
                let a = nodes.first { $0.id == link.from }?.label ?? link.from
                let b = nodes.first { $0.id == link.to }?.label ?? link.to
                out.append("- \(a) → \(b) (\(link.relation))")
            }
        }
        return out.joined(separator: "\n")
    }

    // MARK: Layout

    /// Radial tree: every root owns a slice of the circle and hands a
    /// sub-slice to each child, so the map opens outward as it grows.
    func layout() {
        let roots = nodes.filter { $0.parent == nil }
        guard !roots.isEmpty else { return }
        var placed: [String: CGPoint] = [:]

        func place(_ node: MapNode, from: ClosedRange<Double>, radius: Double, origin: CGPoint) {
            let mid = (from.lowerBound + from.upperBound) / 2
            let point = CGPoint(
                x: origin.x + cos(mid) * radius,
                y: origin.y + sin(mid) * radius
            )
            placed[node.id] = point
            let kids = nodes.filter { $0.parent == node.id }
            guard !kids.isEmpty else { return }
            // Children never fan wider than their parent's slice, so
            // sibling subtrees can't overlap.
            let span = (from.upperBound - from.lowerBound)
            let step = span / Double(kids.count)
            for (i, kid) in kids.enumerated() {
                let lo = from.lowerBound + step * Double(i)
                place(kid, from: lo...(lo + step), radius: 0.17, origin: point)
            }
        }

        if roots.count == 1 {
            placed[roots[0].id] = .zero
            let kids = nodes.filter { $0.parent == roots[0].id }
            let step = (2 * Double.pi) / Double(max(kids.count, 1))
            for (i, kid) in kids.enumerated() {
                let lo = step * Double(i) - .pi / 2
                place(kid, from: lo...(lo + step), radius: 0.24, origin: .zero)
            }
        } else {
            let step = (2 * Double.pi) / Double(roots.count)
            for (i, root) in roots.enumerated() {
                let lo = step * Double(i) - .pi / 2
                place(root, from: lo...(lo + step), radius: 0.22, origin: .zero)
            }
        }

        for i in nodes.indices {
            nodes[i].point = placed[nodes[i].id] ?? .zero
        }
    }

    static func slug(_ s: String) -> String {
        let lowered = s.lowercased()
        let cleaned = lowered.map { ch -> Character in
            (ch.isLetter || ch.isNumber) ? ch : "-"
        }
        return String(cleaned)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
    }
}
