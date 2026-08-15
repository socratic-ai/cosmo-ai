import Foundation

/// A normalized point in `[0,1]`, **top-left origin** (y increases downward) —
/// the same convention as ``NormalizedBox`` and the on-device Vision tools.
public struct NormalizedPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}
