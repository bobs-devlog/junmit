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
        .executable(name: "mention-cache", targets: ["mention-cache"]),
        .executable(name: "adf", targets: ["adf"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
        .package(url: "https://github.com/apple/swift-markdown.git", from: "0.4.0"),
    ],
    targets: [
        // SPEAKER_XX 치환 공유 library — adf·mention-cache에서 사용.
        .target(name: "Speakers"),
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
        .executableTarget(
            name: "mention-cache",
            dependencies: [
                "Speakers",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        .executableTarget(
            name: "adf",
            dependencies: [
                "Speakers",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "Markdown", package: "swift-markdown"),
            ]
        ),
    ]
)
