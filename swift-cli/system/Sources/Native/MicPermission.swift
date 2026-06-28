// AVAuthorizationStatus 정수 그대로 반환:
// 0=notDetermined, 1=restricted, 2=denied, 3=authorized
import AVFoundation

func micPermissionStatusInt() -> Int32 {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    switch status {
    case .notDetermined: return 0
    case .restricted:    return 1
    case .denied:        return 2
    case .authorized:    return 3
    @unknown default:    return 0
    }
}

/// 마이크 권한 OS 다이얼로그를 띄우고 응답까지 대기 후 갱신된 상태(위 4-state)를 반환.
/// 네이티브 마이크 전환 전에는 브라우저 getUserMedia가 이 역할을 했다. 비-UI 스레드(Tauri worker)에서
/// 호출되므로 RunLoop을 돌려 completion을 기다린다(시스템 오디오 권한 요청과 동일 패턴).
func requestMicPermissionInt() -> Int32 {
    // 이미 결정된 상태면 다이얼로그 없이 즉시 반환(notDetermined일 때만 OS가 프롬프트).
    if AVCaptureDevice.authorizationStatus(for: .audio) != .notDetermined {
        return micPermissionStatusInt()
    }
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
    while sem.wait(timeout: .now() + 0.05) == .timedOut {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return micPermissionStatusInt()
}
