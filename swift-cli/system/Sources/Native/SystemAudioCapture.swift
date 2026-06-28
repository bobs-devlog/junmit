// 원격회의 시스템 오디오(상대방 음성) 캡처 — CoreAudio Process Tap (macOS 14.4+).
//
// 마이크는 브라우저(Web Audio)가 별도로 잡고, 이 모듈은 시스템 출력 오디오만 네이티브로 캡처한다.
// 종료 후 Rust(convert_recording)가 ffmpeg `amix`로 두 트랙을 오프라인 믹스해 recording.wav를 만든다.
//
// 셋업 시퀀스(AudioCap·AudioTee·meetily 검증): PID→tap→aggregate(tap만, 출력장치 미포함)→IOProc.
//  - aggregate에 출력장치를 넣으면 에코가 생기므로 tap만 포함.
//  - 자기 프로세스(app.junmit)는 tap에서 제외해 우리 앱이 내는 소리가 되먹임되지 않게 한다.
//  - 실측 포맷(스파이크): 48kHz · 2ch · 32-bit float · interleaved. 캡처는 16-bit PCM WAV로 저장.
//
// 권한: 공개 조회 API가 없어(거부 시 에러 없이 무음) private TCC SPI(비-App Store 가용)로 조회·요청한다.
import Foundation
import CoreAudio
import AudioToolbox

// MARK: - TCC private SPI (kTCCServiceAudioCapture)

// int  TCCAccessPreflight(CFStringRef service, CFDictionaryRef options) — 0=granted, 1=denied, 2=unknown
// void TCCAccessRequest(CFStringRef service, CFDictionaryRef options, void (^)(Bool granted))
private typealias TCCPreflightFn = @convention(c) (CFString, CFDictionary?) -> Int32
private typealias TCCRequestFn = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void

private let tccService = "kTCCServiceAudioCapture" as CFString

private func tccSymbol<T>(_ name: String, as type: T.Type) -> T? {
    guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_NOW),
          let sym = dlsym(handle, name) else {
        return nil
    }
    return unsafeBitCast(sym, to: T.self)
}

/// 0=authorized, 1=denied, 2=not_determined (FFI 코드. MicPermission과 의미 다름에 주의 — 여기선 3단계)
func systemAudioPermissionStatusInt() -> Int32 {
    guard let preflight = tccSymbol("TCCAccessPreflight", as: TCCPreflightFn.self) else {
        return 2  // SPI 부재 시 미결정으로 취급 → 캡처 시도가 무음이면 헬스체크가 잡는다
    }
    switch preflight(tccService, nil) {
    case 0: return 0   // granted
    case 1: return 1   // denied
    default: return 2  // unknown(미결정)
    }
}

/// 권한 프롬프트를 띄우고 사용자 응답까지 대기. 반환: 갱신된 상태(0/1/2).
/// 비-UI 스레드(Tauri worker)에서 호출되므로 RunLoop을 돌려 completion을 기다린다.
func requestSystemAudioPermissionInt() -> Int32 {
    guard let request = tccSymbol("TCCAccessRequest", as: TCCRequestFn.self) else {
        return systemAudioPermissionStatusInt()
    }
    let sem = DispatchSemaphore(value: 0)
    request(tccService, nil) { _ in sem.signal() }
    while sem.wait(timeout: .now() + 0.05) == .timedOut {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return systemAudioPermissionStatusInt()
}

// MARK: - 캡처 세션

/// 시작/정지 반환 코드.
enum CaptureResult: Int32 {
    case ok = 0
    case permissionDenied = -1
    case tapCreateFailed = -2
    case aggregateCreateFailed = -3
    case fileCreateFailed = -4
    case ioProcFailed = -5
    case alreadyRunning = -6
    case notRunning = -7
    case unsupportedOS = -8
}

@available(macOS 14.4, *)
private final class SystemAudioCapture {
    static let shared = SystemAudioCapture()

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var extFile: ExtAudioFileRef?

    // 실시간 레벨 미터용 — 오디오 콜백 cadence(규칙적)에서 attack/release ballistics를 적용한 RMS.
    // 스무딩을 RT 콜백에서 하면 폴링/버퍼 aliasing이 없어 UI가 매끄럽게 샘플링만 하면 된다(네이티브 미터 표준).
    // IOProc(RT)가 쓰고 메인이 폴링해 읽는다 — arm64 정렬 Float read/write는 원자적이라 락 없이 안전.
    private(set) var smoothedRMS: Float = 0

    private var running = false

    func start(path: String) -> CaptureResult {
        if running { return .alreadyRunning }

        // 권한: 거부면 즉시 강등(호출부가 마이크만 녹음으로 폴백). 미결정/허용은 시도.
        if systemAudioPermissionStatusInt() == 1 { return .permissionDenied }

        smoothedRMS = 0

        // 1) tap — 전체 시스템 오디오 스테레오 믹스, 자기 프로세스 제외(에코 방지)
        let selfObj = processObject(forPID: getpid())
        let exclude: [AudioObjectID] = selfObj == kAudioObjectUnknown ? [] : [selfObj]
        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: exclude)
        tapDescription.name = "JunmitSystemAudioTap"
        tapDescription.isPrivate = true

        var newTap = AudioObjectID(kAudioObjectUnknown)
        guard AudioHardwareCreateProcessTap(tapDescription, &newTap) == noErr,
              newTap != kAudioObjectUnknown else {
            return .tapCreateFailed
        }
        tapID = newTap

        guard let tapUIDString = tapUID(tapID), let tapFmt = tapFormat(tapID) else {
            cleanup()
            return .tapCreateFailed
        }

        // 2) private aggregate — tap만 포함(출력장치 미포함 = 에코 회피)
        let aggUID = "app.junmit.systemtap.\(getpid())"
        let aggDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Junmit System Audio Tap",
            kAudioAggregateDeviceUIDKey as String: aggUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [],
            kAudioAggregateDeviceTapListKey as String: [[
                kAudioSubTapUIDKey as String: tapUIDString,
                kAudioSubTapDriftCompensationKey as String: true,
            ]],
        ]
        var newAgg = AudioObjectID(kAudioObjectUnknown)
        guard AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &newAgg) == noErr,
              newAgg != kAudioObjectUnknown else {
            cleanup()
            return .aggregateCreateFailed
        }
        aggregateID = newAgg

        // 3) 캡처 출력 파일 — 16-bit PCM WAV (48k 스테레오) 스테이징. 종료 후 Rust가 마이크와 믹스. ExtAudioFile이 f32→i16 변환.
        guard let file = createOutputFile(path: path, sampleRate: tapFmt.mSampleRate,
                                          channels: tapFmt.mChannelsPerFrame, clientFormat: tapFmt) else {
            cleanup()
            return .fileCreateFailed
        }
        extFile = file

        // 4) IOProc — RT 스레드에서 ExtAudioFileWriteAsync(RT-safe)로 기록 + 레벨 미터용 RMS ballistics
        let ioBlock: AudioDeviceIOBlock = { [weak self] (_, inInputData, _, _, _) in
            guard let self, let ext = self.extFile else { return }
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard let first = abl.first, first.mDataByteSize > 0 else { return }
            let frameCount = first.mDataByteSize / UInt32(tapFmt.mBytesPerFrame)

            ExtAudioFileWriteAsync(ext, frameCount, inInputData)

            // 레벨 미터: 이 버퍼의 RMS를 구해 attack/release ballistics를 콜백 cadence에서 적용.
            // alpha = exp(-Δt/τ) (Δt=버퍼 길이) → 버퍼 크기와 무관하게 마이크와 동일 속도감(τ=attack 14ms/release 200ms).
            let sampleCount = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            if let data = first.mData, sampleCount > 0 {
                let floats = data.bindMemory(to: Float.self, capacity: sampleCount)
                var sumSq: Float = 0
                for i in 0..<sampleCount { sumSq += floats[i] * floats[i] }
                let rms = (sumSq / Float(sampleCount)).squareRoot()
                let dt = Float(frameCount) / Float(tapFmt.mSampleRate)
                let tau: Float = rms > self.smoothedRMS ? 0.014 : 0.200
                let alpha = expf(-dt / tau)
                self.smoothedRMS = alpha * self.smoothedRMS + (1 - alpha) * rms
            }
        }

        var newProc: AudioDeviceIOProcID?
        guard AudioDeviceCreateIOProcIDWithBlock(&newProc, aggregateID, nil, ioBlock) == noErr,
              let proc = newProc else {
            cleanup()
            return .ioProcFailed
        }
        ioProcID = proc

        guard AudioDeviceStart(aggregateID, proc) == noErr else {
            cleanup()
            return .ioProcFailed
        }

        running = true
        return .ok
    }

    func stop() -> CaptureResult {
        guard running else { return .notRunning }
        cleanup()
        running = false
        return .ok
    }

    /// 부분 생성된 자원을 역순으로 정리. 실패 경로·정상 stop 공용.
    private func cleanup() {
        if let proc = ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
        }
        ioProcID = nil
        if let ext = extFile {
            ExtAudioFileDispose(ext)  // 비동기 쓰기 flush + 헤더 확정
        }
        extFile = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = kAudioObjectUnknown
        }
        smoothedRMS = 0  // 정지 시 레벨 미터가 0으로 떨어지게
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }

    // MARK: 헬퍼

    private func processObject(forPID pid: pid_t) -> AudioObjectID {
        var translatedID = AudioObjectID(kAudioObjectUnknown)
        var pidValue = pid
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                       UInt32(MemoryLayout<pid_t>.size), &pidValue, &size, &translatedID)
        return translatedID
    }

    private func tapUID(_ tap: AudioObjectID) -> String? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var uid: CFString?
        guard AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &uid) == noErr else { return nil }
        return uid as String?
    }

    private func tapFormat(_ tap: AudioObjectID) -> AudioStreamBasicDescription? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &asbd) == noErr else { return nil }
        return asbd
    }

    private func createOutputFile(path: String, sampleRate: Float64, channels: UInt32,
                                  clientFormat: AudioStreamBasicDescription) -> ExtAudioFileRef? {
        let url = URL(fileURLWithPath: path) as CFURL
        // 파일 포맷: 16-bit signed int, interleaved, packed (WAV)
        var fileFormat = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2 * channels,
            mFramesPerPacket: 1,
            mBytesPerFrame: 2 * channels,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 16,
            mReserved: 0)

        var ext: ExtAudioFileRef?
        guard ExtAudioFileCreateWithURL(url, kAudioFileWAVEType, &fileFormat,
                                        nil, AudioFileFlags.eraseFile.rawValue, &ext) == noErr,
              let ext else { return nil }

        // 클라이언트 포맷 = tap이 주는 f32 → ExtAudioFile이 파일 포맷(i16)으로 변환
        var client = clientFormat
        guard ExtAudioFileSetProperty(ext, kExtAudioFileProperty_ClientDataFormat,
                                      UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client) == noErr else {
            ExtAudioFileDispose(ext)
            return nil
        }

        // 비동기 쓰기 인프라를 비-RT 컨텍스트에서 1회 prime(0프레임·NULL). Apple 문서 권장: 첫 호출은
        // 메모리 할당·락을 수반하므로 RT IOProc에서 처음 부르면 RT 안전성을 깬다. 여기서 미리 초기화하면
        // 이후 IOProc의 write는 락 없이 효율적으로 동작한다.
        _ = ExtAudioFileWriteAsync(ext, 0, nil)
        return ext
    }
}

// MARK: - 버전 게이트 + 엔트리포인트 (FFI에서 호출)

func startSystemAudioCapture(path: String) -> Int32 {
    guard #available(macOS 14.4, *) else { return CaptureResult.unsupportedOS.rawValue }
    return SystemAudioCapture.shared.start(path: path).rawValue
}

func stopSystemAudioCapture() -> Int32 {
    guard #available(macOS 14.4, *) else { return CaptureResult.unsupportedOS.rawValue }
    return SystemAudioCapture.shared.stop().rawValue
}

/// 녹음 중 폴링 — ballistics 적용된(스무딩된) RMS(실시간 레벨 미터용). 미실행 시 0.
func systemAudioLevel() -> Float {
    guard #available(macOS 14.4, *) else { return 0 }
    return SystemAudioCapture.shared.smoothedRMS
}
