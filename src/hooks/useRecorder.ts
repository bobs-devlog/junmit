import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 네이티브 마이크 + 시스템 오디오 녹음 + 실시간 오디오 레벨 측정 훅
 *
 * 마이크는 네이티브 AVAudioEngine(Swift dylib)이 캡처한다(과거 브라우저 getUserMedia+MediaRecorder를
 * 대체). 시스템 오디오(원격회의 상대방 음성)는 CoreAudio Process Tap이 함께 캡처한다. 둘 다 녹음 중
 * app_data_dir 스테이징 파일에 직접 기록되고, 종료 후 Rust(convert_recording)가 읽어 16k 변환·믹스한다.
 * 마이크 권한은 MeetingSelector의 cmd_request_mic_permission이 받는다.
 *
 * 레벨 미터:
 *   마이크·시스템 모두 네이티브가 오디오 cadence에서 ballistics(attack/release 스무딩)를 적용한 RMS를
 *   제공하고, JS는 이를 ~60Hz로 폴링해 max로 합성만 한다(JS 재스무딩 없음). 상대가 말할 때도 미터가
 *   움직여 "원격 음성이 잡히고 있다"를 실시간으로 확인.
 *
 * 반환값:
 *   isRecording       — 녹음 중 여부
 *   elapsed           — 녹음 경과 시간 (초)
 *   level             — 오디오 레벨 0~1 (게이지 표시용)
 *   systemAudioActive — 시스템 오디오 캡처 상태 (null=미확정, false=실패 → 화면이 경고)
 *   abort()           — start() 진행 중 취소
 *   start()           — 녹음 시작
 *   stop()            — 녹음 중지, Promise<boolean>(저장할 녹음 캡처 여부) 반환
 */

// 네이티브 마이크 캡처 시작 실패(주로 권한 거부 — MicCapture.start가 authorized 아니면 강등)를
// RecordingScreen이 권한 다이얼로그로 다루도록 start()가 던지는 에러 마커.
const MIC_PERMISSION_DENIED = "MIC_PERMISSION_DENIED";

// RMS(선형) → 미터 표시값 0~1. dB 스케일 + 노이즈 게이트. 마이크·시스템 오디오 공통 매핑.
function dbNormalize(smoothed: number): number {
  const db = smoothed < 1e-10 ? -100 : 20 * Math.log10(smoothed);
  const DB_GATE = -45; // 이 이하는 배경소음으로 간주
  const DB_MIN = -45;
  const DB_MAX = -5;
  return db < DB_GATE ? 0 : Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
}

// 레벨 폴링 주기(ms) ≈60Hz — 네이티브가 이미 매끄럽게 스무딩한 값을 rAF 렌더와 같은 빈도로 샘플링해
// 매 프레임 신선한 값을 쓴다. cmd_mic_level/cmd_system_audio_level은 단순 원자 읽기라 60Hz도 부담 없음.
const LEVEL_POLL_MS = 16;

export default function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  // 시스템 오디오 캡처 상태(null=미확정/시작 전, true=캡처 중, false=시작 실패: 권한 거부 등).
  // 실패는 조용히 마이크-only로 진행되므로, 원격회의 상대 음성 누락을 녹음 화면이 이 값으로 경고한다.
  const [systemAudioActive, setSystemAudioActive] = useState<boolean | null>(null);

  const timerRef = useRef<number | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const abortRef = useRef(false);
  // 마이크·시스템 캡처가 시작됐는지 — stop()이 어떤 종료 경로(정상·비상·중단)에서도 정지를 보장하게 추적.
  const micStartedRef = useRef(false);
  const systemAudioStartedRef = useRef(false);

  // 시스템 오디오 캡처 시작 — 항상 시도(OS 권한이 게이트). 마이크 시작 직후 거의 동시에(오프라인 믹스
  // 기준점) 호출. 거부·실패(code≠0)면 마이크-only로 조용히 진행(거부는 사용자 선택 — nag 안 함).
  const startSystemAudio = useCallback(async () => {
    try {
      const code = await invoke<number>("cmd_start_system_audio_capture");
      if (code === 0) systemAudioStartedRef.current = true;
      setSystemAudioActive(code === 0);
    } catch {
      // 시작 실패해도 마이크만으로 진행 (경고 표시는 systemAudioActive=false가 담당)
      setSystemAudioActive(false);
    }
  }, []);

  // 레벨 폴링 시작 — 마이크·시스템 네이티브 RMS를 max로 합성해 한 미터에 표시. 시스템 OFF면 그 값이
  // 0이라 마이크만 반영. 폴링은 stop/언마운트에서 정지.
  const startLevelPolling = useCallback(() => {
    if (levelTimerRef.current !== null) return;
    levelTimerRef.current = window.setInterval(() => {
      Promise.all([
        invoke<number>("cmd_mic_level").catch(() => 0),
        systemAudioStartedRef.current
          ? invoke<number>("cmd_system_audio_level").catch(() => 0)
          : Promise.resolve(0),
      ]).then(([micRms, sysRms]) => {
        setLevel(Math.max(dbNormalize(micRms), dbNormalize(sysRms)));
      });
    }, LEVEL_POLL_MS);
  }, []);

  const stopLevelPolling = useCallback(() => {
    if (levelTimerRef.current !== null) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    setLevel(0);
  }, []);

  // 마이크·시스템 캡처 정지 — 모든 종료 경로(정상·비상·중단·언마운트) 공통. 시작된 경우에만 정지 invoke.
  // 멱등이라 어느 경로에서 불려도 안전.
  //
  // ★ 정지 invoke를 반드시 await한다: 네이티브 stop은 ExtAudioFileDispose로 비동기 쓰기를 flush하고
  // WAV 헤더를 확정한다. await 없이 반환하면 직후의 convert_recording이 잘린/미확정 WAV를 읽어 변환이
  // 깨진다(과거 브라우저 경로는 MediaRecorder.onstop의 완성된 Blob을 await해 보장했던 것을 대체).
  const stopCapture = useCallback(async () => {
    stopLevelPolling();
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stops: Promise<unknown>[] = [];
    if (micStartedRef.current) {
      micStartedRef.current = false;
      stops.push(invoke("cmd_stop_mic_capture").catch(() => {}));
    }
    if (systemAudioStartedRef.current) {
      systemAudioStartedRef.current = false;
      stops.push(invoke("cmd_stop_system_audio_capture").catch(() => {}));
    }
    setSystemAudioActive(null);
    await Promise.all(stops);
  }, [stopLevelPolling]);

  // start() 진행 중 취소.
  const abort = useCallback(() => {
    abortRef.current = true;
  }, []);

  const start = useCallback(async () => {
    abortRef.current = false;
    micStartedRef.current = false;
    systemAudioStartedRef.current = false;
    // 이전 회의의 잔여 elapsed를 즉시 0으로 — start invoke await 동안 RecordingScreen의 리마인더·트레이·
    // 사이드바가 직전 회의 값(예: 60)을 보고 오작동하는 것을 방지.
    setElapsed(0);
    setSystemAudioActive(null);

    const code = await invoke<number>("cmd_start_mic_capture");

    // await 동안 abort가 호출되면 캡처만 시작하고 즉시 정지(이후 단계는 동기라 추가 체크 불필요).
    if (abortRef.current) {
      if (code === 0) void invoke("cmd_stop_mic_capture").catch(() => {});
      return;
    }

    if (code !== 0) {
      // 네이티브 캡처 시작 실패. RecordingScreen이 권한 다이얼로그를 띄우도록 NotAllowedError처럼 던진다.
      const err = new Error("마이크 캡처를 시작하지 못했습니다");
      err.name = MIC_PERMISSION_DENIED;
      throw err;
    }
    micStartedRef.current = true;

    setIsRecording(true);

    // 경과 타이머 (JS 유지 — 네이티브 전환과 무관)
    const startTime = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 500);

    // 시스템 오디오 캡처 + 레벨 폴링 (마이크 시작 직후)
    await startSystemAudio();
    startLevelPolling();
  }, [startSystemAudio, startLevelPolling]);

  // 녹음 중지 — 마이크·시스템 캡처 정지. 반환: 저장할 녹음이 캡처됐는지(true=세션 저장 진행).
  // stopCapture를 await해 네이티브 flush 완료를 보장한 뒤 반환한다(직후 저장이 완성된 파일을 읽도록).
  const stop = useCallback(async (): Promise<boolean> => {
    const wasRecording = micStartedRef.current;
    await stopCapture();
    setIsRecording(false);
    return wasRecording;
  }, [stopCapture]);

  // 언마운트 시 정리 — best-effort(저장이 뒤따르지 않으므로 await 불필요, promise는 떠다님).
  useEffect(() => {
    return () => {
      void stopCapture();
    };
  }, [stopCapture]);

  return { isRecording, elapsed, level, systemAudioActive, abort, start, stop };
}

export { MIC_PERMISSION_DENIED };
