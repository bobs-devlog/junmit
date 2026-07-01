import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AUTO_STOP_SILENCE_MIN,
  AUTO_STOP_SILENCE_LEVEL,
  AUTO_STOP_SILENCE_WARN_LEAD_MIN,
  MAX_RECORDING_MIN,
  MAX_RECORDING_WARN_LEAD_MIN,
  MAX_RECORDING_SNOOZE_MIN,
} from "@/constants";
import {
  showReminderWindow,
  hideReminderWindow,
  type ReminderAction,
} from "@/utils/reminderWindow";

// 종료를 깜빡한 녹음을 저장 후 종료(리마인더는 알림만, 여기서 실제로 끝냄). 세 계기:
//  - 무음·상한: 1초 틱으로 감시. 시간은 틱 횟수가 아니라 벽시계(Date.now 델타)로 누적한다 —
//    App Nap이 백그라운드 타이머를 정지/스로틀시켜 틱 카운트가 부정확하기 때문. 둘 다 종료 전 경고를 띄운다.
//  - 시스템 슬립: 타이머가 아니라 네이티브 신호(app:sleep_detected)로 감시 — 타이머 공백으로 슬립을 추정하면
//    App Nap 정지와 구분이 안 돼 회의 중 오종료됐다(실측).
// 경고 창은 리마인더와 공유하고 kind로 구분한다(창 소유는 useRecordingReminder).

interface UseRecordingAutoStopOptions {
  activity: Activity;
  isRecording: boolean;
  // recorder.level (0~1, mic·system 합성). 60Hz로 갱신되므로 effect deps가 아닌 ref로 샘플링한다.
  level: number;
  isCalendar: boolean;
  // 저장 후 종료 — RecordingScreen.handleStop 주입(리마인더와 동일한 단방향 결합).
  onStop: () => void;
}

const TICK_MS = 1000;
// 틱 간격이 이 값 이하일 때만 레벨 샘플을 신뢰(스로틀된 틱은 무음 누적에서 제외 — 조기 종료 방지).
const SILENCE_SAMPLE_MAX_GAP_MS = 3000;
const SILENCE_LIMIT_SEC = AUTO_STOP_SILENCE_MIN * 60;
const SILENCE_WARN_LEAD_SEC = AUTO_STOP_SILENCE_WARN_LEAD_MIN * 60;
const CAP_SEC = MAX_RECORDING_MIN * 60;
const CAP_WARN_LEAD_SEC = MAX_RECORDING_WARN_LEAD_MIN * 60;
const CAP_SNOOZE_SEC = MAX_RECORDING_SNOOZE_MIN * 60;

export default function useRecordingAutoStop(opts: UseRecordingAutoStopOptions): void {
  const { activity, isRecording, level, isCalendar, onStop } = opts;

  // 틱/리스너 콜백에서 최신값 참조용 ref (stale closure·60Hz 재구독 회피).
  const levelRef = useRef(level);
  const onStopRef = useRef(onStop);
  const isCalendarRef = useRef(isCalendar);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);
  useEffect(() => {
    isCalendarRef.current = isCalendar;
  }, [isCalendar]);

  const capSecRef = useRef(CAP_SEC);
  const capWarnedRef = useRef(false);
  const silenceWarnedRef = useRef(false);
  // silenceSec은 틱 지역변수라 리스너가 직접 못 건드린다 — "계속 녹음" 시 플래그로 다음 틱에 리셋을 요청.
  const silenceResetRef = useRef(false);
  // 중복 종료 방지 — stop 액션 시 useRecordingReminder가 onStop을 부르므로 여기선 틱 재발만 막는다.
  const firedRef = useRef(false);

  // 경고 창 액션(reminder:action) — cap snooze=상한 연장, silence snooze("계속 녹음")=무음 리셋, stop=종료됨 표시.
  // duration snooze는 useRecordingReminder 몫이라 여기선 무시. 마운트 1회 등록.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<ReminderAction>("reminder:action", (event) => {
      if (cancelled) return;
      const { action, kind } = event.payload;
      if (action === "snooze" && kind === "cap") {
        capSecRef.current += CAP_SNOOZE_SEC;
        capWarnedRef.current = false;
      } else if (action === "snooze" && kind === "silence") {
        // "계속 녹음" — 무음 누적을 리셋(다음 틱에서)하고 경고 재무장.
        silenceResetRef.current = true;
        silenceWarnedRef.current = false;
      } else if (action === "stop") {
        firedRef.current = true;
      }
    })
      .then((fn) => {
        if (cancelled) {
          try {
            fn();
          } catch {}
        } else {
          unlisten = fn;
        }
      })
      .catch((e) => console.error("[autostop] listen 등록 실패:", e));
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {}
    };
  }, []);

  // 시스템 슬립(주로 뚜껑 닫기) → 저장 후 종료. 유휴 슬립은 네이티브가 막으므로 이 이벤트는 자리 비움 신호다.
  // 관찰자는 녹음 구간에만 등록돼 녹음 중에만 도착. 마운트 1회 등록.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen("app:sleep_detected", () => {
      if (cancelled || firedRef.current) return;
      firedRef.current = true;
      console.info("[autostop] 자동 종료 트리거: sleep");
      onStopRef.current();
    })
      .then((fn) => {
        if (cancelled) {
          try {
            fn();
          } catch {}
        } else {
          unlisten = fn;
        }
      })
      .catch((e) => console.error("[autostop] sleep listen 등록 실패:", e));
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {}
    };
  }, []);

  // 무음·상한 두 계층을 감시하는 단일 틱. 녹음 중에만 가동.
  useEffect(() => {
    const recording = activity === Activity.Recording && isRecording;
    if (!recording) return;

    // 회의마다 카운터 초기화.
    firedRef.current = false;
    capWarnedRef.current = false;
    capSecRef.current = CAP_SEC;
    silenceWarnedRef.current = false;
    silenceResetRef.current = false;
    let silenceSec = 0;
    let activeSec = 0;
    let lastTickMs = Date.now();

    const fire = (reason: string) => {
      if (firedRef.current) return;
      firedRef.current = true;
      console.info(`[autostop] 자동 종료 트리거: ${reason} (활성 ${Math.round(activeSec)}s)`);
      onStopRef.current();
    };

    const id = window.setInterval(() => {
      if (firedRef.current) return;

      const now = Date.now();
      const gapMs = now - lastTickMs;
      lastTickMs = now;

      const gapSec = gapMs / 1000;
      activeSec += gapSec; // 세션 경과 실시간 — 상한 판정 기준

      if (silenceResetRef.current) {
        silenceResetRef.current = false;
        silenceSec = 0; // "계속 녹음" 요청
      }

      // ① 무음 — 정상 틱 & 레벨 이하일 때만 누적. LEAD 전 경고, 한도 도달 시 종료. 소리가 돌아오면 리셋·경고 철회.
      if (gapMs <= SILENCE_SAMPLE_MAX_GAP_MS && levelRef.current <= AUTO_STOP_SILENCE_LEVEL) {
        silenceSec += gapSec;
        if (!silenceWarnedRef.current && silenceSec >= SILENCE_LIMIT_SEC - SILENCE_WARN_LEAD_SEC) {
          silenceWarnedRef.current = true;
          void showReminderWindow({
            elapsedSec: Math.round(activeSec),
            overSec: 0,
            isCalendar: isCalendarRef.current,
            kind: "silence",
          });
        }
        if (silenceSec >= SILENCE_LIMIT_SEC) {
          fire("silence");
          return;
        }
      } else {
        silenceSec = 0;
        if (silenceWarnedRef.current) {
          silenceWarnedRef.current = false;
          void hideReminderWindow(); // 우리가 띄운 무음 경고만 철회
        }
      }

      // ② 절대 상한 — LEAD 전 경고, 도달 시 종료. "다시 알림" 시 capSecRef 연장 → 경고 재무장.
      if (!capWarnedRef.current && activeSec >= capSecRef.current - CAP_WARN_LEAD_SEC) {
        capWarnedRef.current = true;
        void showReminderWindow({
          elapsedSec: Math.round(activeSec),
          overSec: 0,
          isCalendar: isCalendarRef.current,
          kind: "cap",
          snoozeMin: MAX_RECORDING_SNOOZE_MIN,
        });
      }
      if (activeSec >= capSecRef.current) {
        fire("cap");
      }
    }, TICK_MS);

    return () => {
      window.clearInterval(id);
    };
  }, [activity, isRecording]);
}
