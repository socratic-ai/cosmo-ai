// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Shipped to two mirrors with different shapes. In the monorepo and in
// cosmo-swift-sdk the SDK sits at ``../..``; in cosmo-examples this lands
// at ``swift/HelloRealtime`` with no SDK above it, so it builds against
// the published package instead. Probing for the SDK manifest at the path
// the local dependency would use keeps one file correct in all three.
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
    name: "HelloRealtime",
    platforms: [
        .macOS(.v13),
    ],
    dependencies: [
        sdkDependency,
    ],
    targets: [
        .executableTarget(
            name: "HelloRealtime",
            dependencies: [
                .product(name: "CosmoRealtime", package: sdkPackage),
            ],
            path: "Sources/HelloRealtime"
        ),
        .executableTarget(
            name: "MCPExample",
            dependencies: [
                .product(name: "CosmoRealtime", package: sdkPackage),
            ],
            path: "Sources/MCPExample"
        ),
        .executableTarget(
            name: "HooksExample",
            dependencies: [
                .product(name: "CosmoRealtime", package: sdkPackage),
            ],
            path: "Sources/HooksExample"
        ),
        .executableTarget(
            name: "SkillsExample",
            dependencies: [
                .product(name: "CosmoRealtime", package: sdkPackage),
            ],
            path: "Sources/SkillsExample"
        ),
    ]
)
