// swift-tools-version: 5.9
import Foundation
import PackageDescription

// This example ships to two mirrors with different shapes. In the monorepo
// and in cosmo-swift-sdk the SDK sits at ``../..``; in cosmo-examples it
// lands at ``swift/Cartographer`` with no SDK above it, so it builds
// against the published package instead. Probing for the SDK manifest at
// the path the local dependency would use keeps one file correct in all
// three layouts.
let sdkRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
let sdkIsSibling = FileManager.default.fileExists(
    atPath: sdkRoot.appendingPathComponent("Package.swift").path
)

// A path dependency is aliased to the SDK's own ``name:`` (``CosmoAI``);
// a URL dependency takes its identity from the repo instead.
let sdkPackage = sdkIsSibling ? "CosmoAI" : "cosmo-swift-sdk"
let sdkDependency: Package.Dependency = sdkIsSibling
    ? .package(name: "CosmoAI", path: "../..")
    : .package(
        url: "https://github.com/socratic-ai/cosmo-swift-sdk",
        .upToNextMinor(from: "0.2.0")
    )

let package = Package(
    name: "Cartographer",
    platforms: [
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
