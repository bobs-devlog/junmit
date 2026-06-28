import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity, REMINDER_SNOOZE_MIN } from "@/constants";
import { initReminderWindow, showReminderWindow, hideReminderWindow } from "@/utils/reminderWindow";

// 사용자가 "다시 알림"을 누른 시점부터 재트리거까지 간격(초). 상수라 effect deps에 넣지 않는다.
const SNOOZE_INTERVAL_SEC = REMINDER_SNOOZE_MIN * 60;

interface UseRecordingReminderOptions {
  activity: Activity;
  isRecording: boolean;
  elapsed: number;
  durationMin: number;
  isCalendar: boolean;
  // 리마인더 "종료" 액션 — 호출자가 주입(녹음 정지). listener↔handleStop 결합을 단방향화.
  onStop: () => void;
}

interface UseRecordingReminder {
  // 다음 트리거가 발생할 elapsed 값 — 사이드바 타이머 표시 기준.
  nextTriggerSec: number;
}

// 녹음 종료 시각 리마인더(플로팅 윈도우) — RecordingScreen에서 분리한 단일 책임(SRP).
// 자동 중지 없이 사용자에게 결정 위임. 첫 트리거는 duration 정각, "다시 알림" 시 그 시점 + 간격.
export default function useRecordingReminder(
  opts: UseRecordingReminderOptions
): UseRecordingReminder {
  const { activity, isRecording, elapsed, durationMin, isCalendar, onStop } = opts;

  const [nextTriggerSec, setNextTriggerSec] = useState<number>(durationMin * 60);
  // 동일 시점 중복 발사 방지.
  const triggeredAtRef = useRef<number | null>(null);
  // listen 콜백 안에서 최신값 참조용 (stale closure 회피).
  const elapsedRef = useRef(elapsed);
  const onStopRef = useRef(onStop);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  // 리마인더 윈도우를 백그라운드로 미리 생성 — Tauri 2 transparent 윈도우의 첫 페인트 깜빡임 회피.
  useEffect(() => {
    void initReminderWindow();
  }, []);

  // duration 변경/activity 리셋 시 트리거 시각 초기화.
  useEffect(() => {
    if (activity !== Activity.Recording) {
      triggeredAtRef.current = null;
      setNextTriggerSec(durationMin * 60);
      return;
    }
  }, [activity, durationMin]);

  // 트리거 발사 감시.
  // isRecording 가드 필수 — start()가 마이크 캡처 시작(cmd_start_mic_capture)을 await하는 동안엔 elapsed가
  // 이전 회의의 마지막 값으로 남아있어, 가드 없으면 새 회의 시작 즉시 오발사된다. start()는 캡처 시작 후에야
  // setIsRecording(true)+타이머(setElapsed)를 적용하므로 그 이후에만 평가.
  useEffect(() => {
    if (activity !== Activity.Recording || !isRecording) return;
    if (elapsed >= nextTriggerSec && triggeredAtRef.current !== nextTriggerSec) {
      triggeredAtRef.current = nextTriggerSec;
      void showReminderWindow({
        elapsedSec: elapsed,
        overSec: Math.max(0, elapsed - durationMin * 60),
        isCalendar,
      });
    }
  }, [activity, isRecording, elapsed, nextTriggerSec, durationMin, isCalendar]);

  // 리마인더 윈도우의 사용자 액션 처리. "stop"=즉시 종료, "snooze"=현재 elapsed + 간격으로 갱신.
  // 어느 쪽이든 윈도우는 hide(close 아님) — 재사용으로 다음 트리거 깜빡임 회피.
  // onStop은 ref로 참조해 listener를 마운트 1회만 등록(콜백 변경 시 재등록 회피).
  // StrictMode 이중 마운트 race 방지를 위해 cancelled 플래그로 listen 결과를 가드.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("reminder:action", (event) => {
      if (cancelled) return;
      void hideReminderWindow();
      if (event.payload === "stop") {
        onStopRef.current();
      } else if (event.payload === "snooze") {
        setNextTriggerSec(elapsedRef.current + SNOOZE_INTERVAL_SEC);
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
      .catch((e) => console.error("[reminder] listen 등록 실패:", e));
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {}
    };
  }, []);

  // 화면 언마운트 시 — hide만(close 아님). 다음 회의에서도 재사용(즉시 새 회의 시작 race·깜빡임 회피).
  useEffect(() => {
    return () => {
      void hideReminderWindow();
    };
  }, []);

  return { nextTriggerSec };
}
