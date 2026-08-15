// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CosmoAI",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "CosmoRealtime", targets: ["CosmoRealtime"]),
        // The server-side mint capability (``RealtimeClient.mintToken``),
        // opt-in on purpose: the realistic device consumer must never mint,
        // so a plain ``import CosmoRealtime`` doesn't see the method.
        .library(name: "CosmoRealtimeMint", targets: ["CosmoRealtimeMint"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-openapi-generator",
            from: "1.6.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-runtime",
            from: "1.5.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-urlsession",
            from: "1.0.0"
        ),
        .package(
            url: "https://github.com/livekit/client-sdk-swift.git",
            // Floor 2.15.2: 2.15.1's #1044 wraps the SDK's ObjC auto-async
            // bridging in explicit checked continuations — the crash shape of
            // the macOS 26.1 first-mic-publish SIGSEGV (upstream
            // #1016). Earlier 2.x can resume a continuation against a freed
            // publication there.
            from: "2.15.2"
        ),
    ],
    targets: [
        // Generated models + client for the published developer API.
        // Implementation detail — consumers import ``CosmoRealtime`` only.
        .target(
            name: "CosmoRealtimeAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
        .target(
            name: "CosmoRealtime",
            dependencies: [
                "CosmoRealtimeAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
        .target(
            name: "CosmoRealtimeMint",
            dependencies: [
                "CosmoRealtime",
                "CosmoRealtimeAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ]
        ),
        .testTarget(
            name: "CosmoRealtimeTests",
            dependencies: [
                "CosmoRealtime",
                "CosmoRealtimeMint",
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
        // E2E tests that run against a real ``livekit-server`` in dev
        // mode. Skipped unless ``LIVEKIT_TESTING_URL`` is set in the
        // environment. To run locally:
        //
        //   livekit-server --dev   (any local LiveKit server in dev mode)
        //   LIVEKIT_TESTING_URL=ws://localhost:7880 \
        //     LIVEKIT_TESTING_API_KEY=devkey \
        //     LIVEKIT_TESTING_API_SECRET=devsecretdevsecretdevsecretdevse \
        //     swift test
        .testTarget(
            name: "CosmoRealtimeE2ETests",
            dependencies: [
                "CosmoRealtime",
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
    ]
)
