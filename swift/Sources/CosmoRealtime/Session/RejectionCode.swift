import Foundation

/// Extract the protocol error code from a rejection body: the external
/// envelope (``{"error": {"code": "...", ...}}``), falling back to the
/// internal FastAPI shape (``{"detail": {"code": "...", ...}}``).
func rejectionCode(inBody body: String) -> String? {
    struct Rejection: Decodable {
        struct Slugged: Decodable {
            let code: String?
        }
        let error: Slugged?
        let detail: Slugged?
    }
    guard let rejection = try? JSONDecoder().decode(Rejection.self, from: Data(body.utf8))
    else { return nil }
    return rejection.error?.code ?? rejection.detail?.code
}
