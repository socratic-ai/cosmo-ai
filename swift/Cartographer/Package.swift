// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Cartographer",
    platforms: [
        .macOS(.v14),
    ],
    dependencies: [
        // ``name:`` aliases the path-based parent to ``CosmoAI`` — without
        // it SwiftPM falls back to the parent directory name (``swift``),
        // which then fails to resolve ``package: "CosmoAI"`` below.
        .package(name: "CosmoAI", path: "../.."),
    ],
    targets: [
        .executableTarget(
            name: "Cartographer",
            dependencies: [
                .product(name: "CosmoRealtime", package: "CosmoAI"),
            ],
            path: "Sources/Cartographer"
        ),
        .executableTarget(
            name: "Probe",
            dependencies: [
                .product(name: "CosmoRealtime", package: "CosmoAI"),
            ],
            path: "Sources/Probe"
        ),
    ]
)
