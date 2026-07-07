// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "diarize",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "diarize", targets: ["diarize"]),
        .executable(name: "whisper-parse", targets: ["whisper-parse"]),
        .executable(name: "apply-edits", targets: ["apply-edits"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "diarize",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        .executableTarget(
            name: "whisper-parse",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        .executableTarget(
            name: "apply-edits",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
    ]
)
