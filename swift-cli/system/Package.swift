// swift-tools-version:5.9
// 메인 앱에 link되어 EventKit/AVFoundation 호출을 bundle identity로 TCC에 귀속시키는 dylib.
import PackageDescription

let package = Package(
    name: "system",
    platforms: [
        .macOS("14.4"),
    ],
    products: [
        .library(
            name: "Native",
            type: .dynamic,
            targets: ["Native"]
        ),
    ],
    targets: [
        // ObjC @try/@catch 션트 — Swift가 못 잡는 AVAudioEngine NSException을 Bool 실패로 변환.
        .target(name: "ObjCSupport"),
        .target(name: "Native", dependencies: ["ObjCSupport"]),
    ]
)
