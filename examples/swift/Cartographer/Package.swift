// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Builds against the published package. When a local SDK checkout exists
// at the sibling path the probe below finds (SDK development), the local
// sources are used instead — the same file works in both layouts.
let sdkRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("swift")
let sdkIsSibling = FileManager.default.fileExists(
    atPath: sdkRoot.appendingPathComponent("Package.swift").path
)

// A path dependency is aliased to the SDK's own ``name:`` (``CosmoAI``);
// a URL dependency takes its identity from the repo instead.
let sdkPackage = sdkIsSibling ? "CosmoAI" : "cosmo-swift-sdk"
let sdkDependency: Package.Dependency = sdkIsSibling
    ? .package(name: "CosmoAI", path: "../../../swift")
    : .package(url: "https://github.com/socratic-ai/cosmo-swift-sdk", from: "0.5.0")

let package = Package(
    name: "Cartographer",
    platforms: [
        // Higher than the SDK's own macOS 13 floor: the UI uses SwiftUI's
        // `onChange(of:initial:_:)` and `defaultScrollAnchor`, both macOS 14.
        .macOS(.v14),
    ],
    dependencies: [
        sdkDependency,
    ],
    targets: [
        .executableTarget(
            name: "Cartographer",
            dependencies: [
                .product(name: "CosmoRealtime", package: sdkPackage),
            ],
            path: "Sources/Cartographer"
        ),
        .executableTarget(
            name: "Probe",
            dependencies: [
                .product(name: "CosmoRealtime", package: sdkPackage),
            ],
            path: "Sources/Probe"
        ),
    ]
)
