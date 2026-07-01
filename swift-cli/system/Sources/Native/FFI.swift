// C ABI exports. 반환된 포인터는 호출자가 native_free_string으로 해제해야 한다.
import Foundation

@_cdecl("native_fetch_calendar_events")
public func native_fetch_calendar_events(_ dateISO: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let dateStr: String = dateISO.map { String(cString: $0) } ?? ""
    let json = fetchCalendarEventsJSON(dateString: dateStr)
    return strdup(json)
}

@_cdecl("native_mic_permission_status")
public func native_mic_permission_status() -> Int32 {
    return micPermissionStatusInt()
}

@_cdecl("native_calendar_permission_status")
public func native_calendar_permission_status() -> Int32 {
    return calendarPermissionStatusInt()
}

// 마이크 권한 OS 다이얼로그를 띄우고 응답까지 대기. 반환: 갱신된 상태(0/1/2/3).
@_cdecl("native_request_mic_permission")
public func native_request_mic_permission() -> Int32 {
    return requestMicPermissionInt()
}

// 마이크 캡처 — AVAudioEngine (네이티브). 브라우저 getUserMedia+MediaRecorder 대체.

// path로 16-bit WAV(48k mono)를 기록 시작. 반환: CaptureResult(0=ok, 음수=실패).
@_cdecl("native_start_mic_capture")
public func native_start_mic_capture(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let path = path else { return -4 }
    return startMicCapture(path: String(cString: path))
}

@_cdecl("native_stop_mic_capture")
public func native_stop_mic_capture() -> Int32 {
    return stopMicCapture()
}

// 녹음 중 폴링 — ballistics 적용된 RMS (실시간 레벨 미터용). 미실행 시 0.
@_cdecl("native_mic_level")
public func native_mic_level() -> Float {
    return micLevel()
}

// 시스템 오디오(원격회의 상대방 음성) 캡처 — CoreAudio Process Tap.
// 권한 코드: 0=authorized, 1=denied, 2=not_determined (TCC SPI).

@_cdecl("native_system_audio_permission_status")
public func native_system_audio_permission_status() -> Int32 {
    return systemAudioPermissionStatusInt()
}

@_cdecl("native_request_system_audio_permission")
public func native_request_system_audio_permission() -> Int32 {
    return requestSystemAudioPermissionInt()
}

// path로 16-bit WAV 스템을 기록 시작. 반환: CaptureResult(0=ok, 음수=실패/거부).
@_cdecl("native_start_system_audio_capture")
public func native_start_system_audio_capture(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let path = path else { return -4 }
    return startSystemAudioCapture(path: String(cString: path))
}

@_cdecl("native_stop_system_audio_capture")
public func native_stop_system_audio_capture() -> Int32 {
    return stopSystemAudioCapture()
}

// 녹음 중 폴링 — 직전 버퍼 RMS (실시간 레벨 미터용). 미실행 시 0.
@_cdecl("native_system_audio_level")
public func native_system_audio_level() -> Float {
    return systemAudioLevel()
}

// 녹음 중 전원 관리 — App Nap/유휴 슬립 방지 + 슬립 감지(PowerManagement).

// 녹음 시작 시 호출 — App Nap·유휴 슬립을 막고 willSleep 관찰을 시작한다.
@_cdecl("native_begin_recording_activity")
public func native_begin_recording_activity() {
    PowerManagement.shared.begin()
}

// 녹음 종료 시 호출 — 활동·관찰을 해제한다.
@_cdecl("native_end_recording_activity")
public func native_end_recording_activity() {
    PowerManagement.shared.end()
}

// 앱 시작 시 1회 호출 — 시스템 willSleep 시 호출될 콜백을 등록한다(Rust가 Tauri 이벤트로 중계).
@_cdecl("native_set_sleep_callback")
public func native_set_sleep_callback(_ cb: @convention(c) @escaping () -> Void) {
    PowerManagement.shared.setSleepCallback(cb)
}

@_cdecl("native_free_string")
public func native_free_string(_ ptr: UnsafeMutablePointer<CChar>?) {
    if let ptr = ptr { free(ptr) }
}
