// swift-tools-version: 5.9
import PackageDescription

// Core logic for the ChessReferee example: the on-device board detector,
// FEN assembly, and the referee state machine. Split from the app target so
// the whole pipeline runs and tests on macOS with `swift test` — no
// simulator needed to validate the detector against the golden fixture.
let package = Package(
    name: "RefereeKit",
    platforms: [
        .iOS(.v16),
        .macOS(.v14),
    ],
    products: [
        .library(name: "RefereeKit", targets: ["RefereeKit"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/microsoft/onnxruntime-swift-package-manager",
            from: "1.19.0"
        ),
        .package(
            url: "https://github.com/chesskit-app/chesskit-swift",
            from: "0.9.0"
        ),
    ],
    targets: [
        .target(
            name: "RefereeKit",
            dependencies: [
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
                .product(name: "ChessKit", package: "chesskit-swift"),
            ]
        ),
        .testTarget(
            name: "RefereeKitTests",
            dependencies: ["RefereeKit"],
            resources: [
                .copy("Fixtures")
            ]
        ),
    ]
)
