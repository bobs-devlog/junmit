// 녹음 종료 시각 리마인더 — 별도 Tauri WebviewWindow에서 렌더되는 플로팅 카드.
// 메인 앱 시작 시 visible:false로 미리 생성되어 webview·React 마운트가 완료된 상태로 대기.
// 트리거 시점에 메인이 "reminder:data" 이벤트로 payload를 보내면 state 갱신 후 메인이 show 호출.
// 사용자 액션은 "reminder:action" Tauri 이벤트로 메인 윈도우에 { action, kind }로 전달.
// kind를 함께 보내야 메인의 두 리스너(useRecordingReminder=duration, useRecordingAutoStop=cap)가
// 자기 종류의 액션만 처리한다 — duration snooze가 상한(cap)을 밀어버리는 혼선을 막는다.

import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./reminderWindow.css";

type Action = "stop" | "snooze";

interface ReminderData {
  elapsedSec: number;
  overSec: number;
  isCalendar: boolean;
  kind?: "duration" | "cap" | "silence";
  snoozeMin?: number;
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

// 창에 표시할 문구를 종류별로 묶어 반환한다(중첩 삼항 대신 종류별 응집). cap·silence는 "무반응 시 자동
// 종료" 성격이고, duration은 예정 종료 알림뿐이다.
function reminderCopy(data: ReminderData): {
  headline: string;
  subline: string;
  snoozeLabel: string;
} {
  const { kind, isCalendar, overSec, elapsedSec, snoozeMin } = data;

  if (kind === "cap") {
    return {
      headline: "최대 녹음 시간에 도달했습니다",
      subline: "곧 자동으로 저장·종료됩니다 · 계속하려면 아래를 누르세요",
      snoozeLabel: `${snoozeMin ?? 30}분 더 녹음`,
    };
  }
  if (kind === "silence") {
    return {
      headline: "소리가 없어 곧 종료됩니다",
      subline: "곧 자동으로 저장·종료됩니다 · 계속하려면 아래를 누르세요",
      snoozeLabel: "계속 녹음",
    };
  }
  // duration(기본) — 예정 종료 시각 알림.
  return {
    headline: isCalendar
      ? "회의 예정 시각이 지났습니다"
      : overSec > 0
        ? "녹음이 예정 시간을 넘었습니다"
        : "녹음 시간을 확인해주세요",
    subline:
      overSec > 0
        ? `예정 종료 +${formatHMS(overSec)} (현재 ${formatHMS(elapsedSec)})`
        : `현재 ${formatHMS(elapsedSec)}`,
    snoozeLabel: `${snoozeMin ?? 10}분 후 다시 알림`,
  };
}

export default function ReminderWindow() {
  // 첫 페인트(아직 hide 상태)는 default 값으로 그려져도 보이지 않음. 데이터 emit 받으면 갱신.
  const [data, setData] = useState<ReminderData>({
    elapsedSec: 0,
    overSec: 0,
    isCalendar: false,
    kind: "duration",
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
    // kind를 함께 실어 메인이 어떤 리마인더(duration/cap)의 액션인지 구분하게 한다.
    try {
      await emit("reminder:action", { action, kind: data.kind ?? "duration" });
    } catch (e) {
      console.error("[reminder] action emit 실패:", e);
      // emit 실패 시 사용자가 갇히지 않도록 self-hide
      try {
        await getCurrentWindow().hide();
      } catch {}
    }
  };

  const { headline, subline, snoozeLabel } = reminderCopy(data);

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
          {snoozeLabel}
        </button>
        <button type="button" className="rm-btn rm-btn-stop" onClick={() => handleAction("stop")}>
          지금 종료
        </button>
      </div>
    </div>
  );
}
