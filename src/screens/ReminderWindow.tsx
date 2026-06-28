// 녹음 종료 시각 리마인더 — 별도 Tauri WebviewWindow에서 렌더되는 플로팅 카드.
// 메인 앱 시작 시 visible:false로 미리 생성되어 webview·React 마운트가 완료된 상태로 대기.
// 트리거 시점에 메인이 "reminder:data" 이벤트로 payload를 보내면 state 갱신 후 메인이 show 호출.
// 사용자 액션은 "reminder:action" Tauri 이벤트로 메인 윈도우에 전달.

import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./reminderWindow.css";

type Action = "stop" | "snooze";

interface ReminderData {
  elapsedSec: number;
  overSec: number;
  isCalendar: boolean;
}

function formatHMS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function ReminderWindow() {
  // 첫 페인트(아직 hide 상태)는 default 값으로 그려져도 보이지 않음. 데이터 emit 받으면 갱신.
  const [data, setData] = useState<ReminderData>({
    elapsedSec: 0,
    overSec: 0,
    isCalendar: false,
  });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<ReminderData>("reminder:data", (event) => {
      if (cancelled) return;
      setData(event.payload);
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
      .catch((e) => console.error("[reminder] data listen 실패:", e));
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {}
    };
  }, []);

  const handleAction = async (action: Action): Promise<void> => {
    // 액션을 메인 윈도우에 알림. 메인이 hide를 호출 — 여기서 close/hide 하지 않음 (재사용 위해).
    try {
      await emit("reminder:action", action);
    } catch (e) {
      console.error("[reminder] action emit 실패:", e);
      // emit 실패 시 사용자가 갇히지 않도록 self-hide
      try {
        await getCurrentWindow().hide();
      } catch {}
    }
  };

  const { elapsedSec, overSec, isCalendar } = data;
  const headline = isCalendar
    ? "회의 예정 시각이 지났습니다"
    : overSec > 0
      ? "녹음이 예정 시간을 넘었습니다"
      : "녹음 시간을 확인해주세요";

  const subline =
    overSec > 0
      ? `예정 종료 +${formatHMS(overSec)} (현재 ${formatHMS(elapsedSec)})`
      : `현재 ${formatHMS(elapsedSec)}`;

  return (
    <div className="rm-root" data-tauri-drag-region>
      <div className="rm-header">
        <span className="rm-dot" />
        <div className="rm-titles">
          <div className="rm-headline">{headline}</div>
          <div className="rm-subline">{subline}</div>
        </div>
      </div>
      <div className="rm-actions">
        <button
          type="button"
          className="rm-btn rm-btn-secondary"
          onClick={() => handleAction("snooze")}
        >
          10분 후 다시 알림
        </button>
        <button type="button" className="rm-btn rm-btn-stop" onClick={() => handleAction("stop")}>
          지금 종료
        </button>
      </div>
    </div>
  );
}
