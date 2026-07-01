// 녹음 중 전원 관리. beginActivity로 App Nap(백그라운드 타이머 정지)과 유휴 슬립(캡처 사멸)을 막는다.
// 유휴 슬립을 막으면 녹음 중 슬립은 뚜껑 닫기 등 사용자 행위뿐이므로, willSleep을 자리 비움 신호로 보고
// Rust에 콜백한다(관찰자는 begin~end 구간에만 등록). AppKit/상태 접근은 모두 메인 스레드에서 한다
// (FFI는 Tauri 비동기 스레드에서 호출되므로 main으로 넘김).

import Foundation
import AppKit

final class PowerManagement {
    static let shared = PowerManagement()

    // 상태는 메인 스레드에서만 접근.
    private var activityToken: NSObjectProtocol?
    private var sleepObserver: NSObjectProtocol?
    private var sleepCallback: (@convention(c) () -> Void)?

    // Rust가 앱 시작 시 1회 등록. willSleep 시 이 C 함수를 호출 → Rust가 Tauri 이벤트 emit.
    func setSleepCallback(_ cb: @escaping @convention(c) () -> Void) {
        DispatchQueue.main.async { self.sleepCallback = cb }
    }

    // 녹음 시작 시 — App Nap + 유휴 슬립 방지 활동 시작 + willSleep 관찰 시작. 멱등.
    func begin() {
        DispatchQueue.main.async {
            if self.activityToken == nil {
                self.activityToken = ProcessInfo.processInfo.beginActivity(
                    options: [.userInitiated, .idleSystemSleepDisabled],
                    reason: "Recording meeting audio"
                )
            }
            if self.sleepObserver == nil {
                self.sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(
                    forName: NSWorkspace.willSleepNotification,
                    object: nil,
                    queue: .main
                ) { [weak self] _ in
                    self?.sleepCallback?()
                }
            }
        }
    }

    // 녹음 종료 시 — 활동 종료 + 관찰 해제. 멱등.
    func end() {
        DispatchQueue.main.async {
            if let token = self.activityToken {
                ProcessInfo.processInfo.endActivity(token)
                self.activityToken = nil
            }
            if let observer = self.sleepObserver {
                NSWorkspace.shared.notificationCenter.removeObserver(observer)
                self.sleepObserver = nil
            }
        }
    }
}
