// 마이크 캡처 — AVAudioEngine (네이티브). 브라우저 getUserMedia+MediaRecorder를 대체한다.
//
// 시스템 오디오(SystemAudioCapture)와 대칭: 전역 캡처 상태 + RMS 레벨 ballistics + ExtAudioFile 기록.
// 캡처는 canonical 48k mono f32로 기록만 하고, 16k 변환·정규화·믹스는 Rust(convert_recording)의 ffmpeg에
// 위임한다(시스템 오디오와 완전 대칭, 듀얼 코드패스 회피).
//
// 레퍼런스(WhisperKit AudioProcessor) 패턴을 따른다:
//  - inputNode를 하드웨어 native 포맷(format:nil)으로 tap하고, 콜백에서 AVAudioConverter로 native→canonical
//    (48k mono)로 변환해 기록한다. (믹서 노드 tap은 입력≠tap 샘플레이트면 캡처 불가 — 실측 -10868.)
//  - 입력 장치는 kAudioOutputUnitProperty_CurrentDevice로 현재 기본 입력 장치에 명시 지정(bindInputDevice).
//    AVAudioEngine.inputNode는 한 번 묶인 장치를 계속 붙들고 기본 장치 변경을 자동 추종하지 않기 때문(macOS
//    함정, Apple 포럼·AudioKit·WhisperKit 공통). 그래서 **세션마다 엔진을 새로 만들고** 현재 장치에 바인딩한다
//    (WhisperKit이 startRecording마다 엔진을 세우는 것과 동일). 싱글톤 엔진 재사용은 직전 세션의 죽은 장치
//    바인딩이 남아 다음 회의 입력이 0이 되는 버그를 낳는다(실측).
//  - 장치 변경(블루투스 연결/해제) 시: AVAudioEngineConfigurationChange + 기본 입력 장치 리스너 두 트리거로
//    엔진을 새 기본 장치에 다시 세운다(buildAndStartEngineLocked 재호출). 단 녹음 중 매끄러운 무중단 전환은
//    레퍼런스(WhisperKit)도 보장하지 않는 어려운 영역 — best-effort.
//  - 그래프 조작은 ObjC 션트(junmitRunCatchingException)로 감싸 전환 중 NSException에 abort하지 않는다.
import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio
import ObjCSupport  // junmitRunCatchingException — Swift가 못 잡는 AVAudioEngine NSException 차단

@available(macOS 14.4, *)
private final class MicCapture {
    static let shared = MicCapture()

    // 캡처 파일 포맷 고정: 48kHz mono float32. 장치가 16k(블루투스)·44.1k·스테레오여도 변환기가 여기에
    // 맞춰 변환하므로 파일은 항상 48k mono(드라이브·장치 변경에도 샘플레이트 일관). 16k는 Rust가 만든다.
    private let canonicalSampleRate: Double = 48000
    private let canonicalFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!

    // 세션마다 새로 만든다(var) — 직전 장치 바인딩 잔존 방지.
    private var engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var extFile: ExtAudioFileRef?
    private var configObserver: NSObjectProtocol?
    private var deviceListener: AudioObjectPropertyListenerBlock?

    // 엔진 lifecycle(start/stop/reconfigure)을 직렬화하는 큐. start/stop은 Tauri worker 스레드, 디바이스 변경은
    // 리스너에서 들어와 서로 다른 스레드로 AVAudioEngine을 만지면 레이스가 난다(AVAudioEngine은 스레드-세이프
    // 아님). 모든 lifecycle 조작을 이 큐로 모아 상호 배제한다. (레벨 RMS read는 lock-free 원자 Float이라 예외.)
    private let queue = DispatchQueue(label: "app.junmit.miccapture")

    // 실시간 레벨 미터용 — SystemAudioCapture와 동일한 attack/release ballistics(τ=14ms/200ms).
    private(set) var smoothedRMS: Float = 0

    private var running = false
    // 마지막으로 엔진을 바인딩한 입력 장치. reconfigure 시 장치가 실제로 바뀐 경우에만 재구축해
    // 중복 트리거(ConfigurationChange+장치리스너 동시)·잠재적 재구성 루프를 막는다.
    private var lastBoundDevice = AudioDeviceID(kAudioObjectUnknown)

    // MARK: start — FFI(worker 스레드)에서 호출, 큐에서 직렬 실행.
    func start(path: String) -> CaptureResult {
        queue.sync { startLocked(path: path) }
    }

    private func startLocked(path: String) -> CaptureResult {
        if running { return .alreadyRunning }

        // 권한 가드: AVAudioEngine.start()는 권한이 거부돼도 성공하고 무음만 전달한다(실측). authorized가 아니면
        // 즉시 강등 → 호출부(useRecorder→RecordingScreen)가 권한 다이얼로그를 띄운다(과거 getUserMedia 안전망 대체).
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            return .permissionDenied
        }

        smoothedRMS = 0
        converter = nil
        converterInputFormat = nil

        guard let file = createOutputFile(path: path) else {
            return .fileCreateFailed
        }
        extFile = file

        // 기본 입력 장치 변경 리스너 등록(BT 해제 등 신뢰 트리거). 콜백은 직렬 큐에서 받아 재구성.
        addDefaultInputDeviceListener()

        guard buildAndStartEngineLocked() else {
            removeDefaultInputDeviceListener()
            ExtAudioFileDispose(file)
            extFile = nil
            return .ioProcFailed
        }

        running = true
        return .ok
    }

    func stop() -> CaptureResult {
        queue.sync { stopLocked() }
    }

    private func stopLocked() -> CaptureResult {
        guard running else { return .notRunning }
        cleanup()
        running = false
        return .ok
    }

    private func cleanup() {
        removeDefaultInputDeviceListener()
        removeConfigObserver()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if let ext = extFile {
            ExtAudioFileDispose(ext)  // 비동기 쓰기 flush + 헤더 확정
        }
        extFile = nil
        converter = nil
        converterInputFormat = nil
        smoothedRMS = 0
    }

    // MARK: 엔진 (재)구축 — start·reconfigure 공용. 새 AVAudioEngine을 만들어 현재 기본 입력 장치에 바인딩하고
    // tap을 건 뒤 가동한다. 새 엔진이라 직전 세션/장치의 잔존 상태가 없다(WhisperKit식 세션별 엔진).
    // 성공(가동 중) 여부 반환. 그래프 조작은 ObjC 션트로 감싸 NSException에 abort하지 않는다.
    @discardableResult
    private func buildAndStartEngineLocked() -> Bool {
        // 이전 엔진 정리(reconfigure 시 기존 엔진 해제).
        removeConfigObserver()
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }

        engine = AVAudioEngine()
        bindInputDevice()  // 현재 기본 입력 장치(BT/빌트인)에 명시 바인딩
        lastBoundDevice = currentDefaultInputDevice()

        _ = junmitRunCatchingException { [self] in
            installTap(on: engine.inputNode)
            engine.prepare()
            try? engine.start()  // Swift 에러는 swallow, 성공 여부는 isRunning으로 확인
        }

        let ok = engine.isRunning
        if ok {
            // 그래프 포맷/장치 변경 알림 — 직렬 큐로 위임해 start/stop과 상호 배제.
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
            ) { [weak self] _ in
                self?.queue.async { self?.reconfigureLocked() }
            }
        }
        return ok
    }

    // MARK: 장치 변경 재구성 (큐에서 직렬 실행) — 엔진을 새 기본 장치에 다시 세운다.
    private func reconfigureLocked() {
        guard running else { return }
        // 기본 입력 장치가 실제로 바뀐 경우에만 재구축 — 중복 트리거·재구성 루프 방지.
        // (단 현재 엔진이 죽어 있으면 같은 장치라도 복구 시도.)
        if currentDefaultInputDevice() == lastBoundDevice, engine.isRunning { return }
        _ = buildAndStartEngineLocked()
        // 실패하면 이번 알림은 건너뜀(다음 트리거 때 재시도). 앱은 죽지 않고, 최악의 경우 캡처만 멈추고 파일 보존.
    }

    private func removeConfigObserver() {
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
    }

    // MARK: 입력 장치 바인딩

    /// 현재 시스템 기본 입력 장치 ID. 조회 실패 시 kAudioObjectUnknown.
    private func currentDefaultInputDevice() -> AudioDeviceID {
        var dev = AudioDeviceID(kAudioObjectUnknown)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
        return dev
    }

    /// 엔진 입력 노드의 AudioUnit을 현재 기본 입력 장치로 지정(엔진 정지 상태에서). WhisperKit의 assignAudioInput과
    /// 동일 — AVAudioEngine이 기본 장치 변경을 자동 추종하지 않는 문제의 명시 보정.
    private func bindInputDevice() {
        let dev = currentDefaultInputDevice()
        guard dev != AudioDeviceID(kAudioObjectUnknown), let au = engine.inputNode.audioUnit else { return }
        var d = dev
        _ = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                 kAudioUnitScope_Global, 0, &d, UInt32(MemoryLayout<AudioDeviceID>.size))
    }

    private var defaultInputDeviceAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    private func addDefaultInputDeviceListener() {
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.reconfigureLocked()  // 이미 아래 등록 시 지정한 직렬 큐에서 실행됨
        }
        deviceListener = block
        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &defaultInputDeviceAddress, queue, block)
    }

    private func removeDefaultInputDeviceListener() {
        guard let block = deviceListener else { return }
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &defaultInputDeviceAddress, queue, block)
        deviceListener = nil
    }

    // MARK: tap + 변환

    /// inputNode에 format:nil(현재 native 포맷)로 tap 부착.
    private func installTap(on input: AVAudioInputNode) {
        input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
            self?.process(buffer)
        }
    }

    /// tap 콜백 — native 버퍼를 canonical(48k mono)로 변환해 기록 + RMS ballistics.
    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let ext = extFile, buffer.frameLength > 0 else { return }

        if converterInputFormat != buffer.format {
            _ = rebuildConverter(for: buffer.format)
        }
        guard let conv = converter else { return }

        let ratio = canonicalSampleRate / buffer.format.sampleRate
        let outCap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 16)
        guard outCap > 0,
              let outBuf = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: outCap) else {
            return
        }

        // feed-once + noDataNow: 동일 변환기 인스턴스가 SR 변환 필터 상태를 콜백 간 유지(스트리밍 정상, 실측).
        var fed = false
        let status = conv.convert(to: outBuf, error: nil) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, outBuf.frameLength > 0 else { return }

        ExtAudioFileWriteAsync(ext, outBuf.frameLength, outBuf.audioBufferList)

        if let ch = outBuf.floatChannelData {
            let n = Int(outBuf.frameLength)
            var sumSq: Float = 0
            for i in 0..<n { let v = ch[0][i]; sumSq += v * v }
            let rms = (sumSq / Float(n)).squareRoot()
            let dt = Float(outBuf.frameLength) / Float(canonicalSampleRate)
            let tau: Float = rms > smoothedRMS ? 0.014 : 0.200
            let alpha = expf(-dt / tau)
            smoothedRMS = alpha * smoothedRMS + (1 - alpha) * rms
        }
    }

    /// 주어진 입력 포맷 → canonical 변환기 생성. 동일 포맷이면 재사용.
    private func rebuildConverter(for inputFormat: AVAudioFormat) -> Bool {
        if let cur = converterInputFormat, cur == inputFormat, converter != nil {
            return true
        }
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0,
              let conv = AVAudioConverter(from: inputFormat, to: canonicalFormat) else {
            return false
        }
        converter = conv
        converterInputFormat = inputFormat
        return true
    }

    /// canonical(f32 mono 48k) 클라이언트 → 16-bit mono 48k WAV 파일. ExtAudioFile이 f32→i16 변환.
    private func createOutputFile(path: String) -> ExtAudioFileRef? {
        let url = URL(fileURLWithPath: path) as CFURL
        var fileFormat = AudioStreamBasicDescription(
            mSampleRate: canonicalSampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
            mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)

        var ext: ExtAudioFileRef?
        guard ExtAudioFileCreateWithURL(url, kAudioFileWAVEType, &fileFormat,
                                        nil, AudioFileFlags.eraseFile.rawValue, &ext) == noErr,
              let ext else { return nil }

        var client = canonicalFormat.streamDescription.pointee
        guard ExtAudioFileSetProperty(ext, kExtAudioFileProperty_ClientDataFormat,
                                      UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client) == noErr else {
            ExtAudioFileDispose(ext)
            return nil
        }

        _ = ExtAudioFileWriteAsync(ext, 0, nil)  // 비-RT 컨텍스트 1회 prime
        return ext
    }
}

// MARK: - 버전 게이트 + 엔트리포인트 (FFI에서 호출)

func startMicCapture(path: String) -> Int32 {
    guard #available(macOS 14.4, *) else { return CaptureResult.unsupportedOS.rawValue }
    return MicCapture.shared.start(path: path).rawValue
}

func stopMicCapture() -> Int32 {
    guard #available(macOS 14.4, *) else { return CaptureResult.unsupportedOS.rawValue }
    return MicCapture.shared.stop().rawValue
}

/// 녹음 중 폴링 — ballistics 적용된 RMS(실시간 레벨 미터용). 미실행 시 0.
func micLevel() -> Float {
    guard #available(macOS 14.4, *) else { return 0 }
    return MicCapture.shared.smoothedRMS
}
