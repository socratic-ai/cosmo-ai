/// Sendable single-value capture box for async test side-effects.
actor CaptureBox<T: Sendable> {
    private(set) var value: T? = nil
    func set(_ v: T) { value = v }
}

/// Sendable invocation counter for async test side-effects.
actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}
