// 녹음 종료 시각 리마인더용 플로팅 윈도우.
// "윈도우 미리 생성 + 재사용" 패턴 — Tauri 2 transparent 윈도우의 첫 페인트 흰 깜빡임
// (Issue #14515) 회피를 위해 회의 시작 시 visible:false로 한 번 생성해 webview를 준비시킨다.
// 이후 트리거 시점엔 데이터 emit + show만 — 깜빡임 없음.
//
// 통신:
//  - 메인 → reminder: "reminder:data" 이벤트로 payload 전달
//  - reminder → 메인: "reminder:action" 이벤트로 { action: "stop"|"snooze", kind: "duration"|"cap" } 통보
//
// 라이프사이클:
//  - initReminderWindow(): 회의 시작 시 1회 (visible:false로 백그라운드 webview 준비)
//  - showReminderWindow(payload): 트리거 시 (데이터 emit + 위치 조정 + show)
//  - hideReminderWindow(): snooze/stop/언마운트 시 (close 아님, 재사용 위해 hide만. 앱 종료 시 OS가 정리)

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";

const REMINDER_LABEL = "app-reminder";
const WIDTH = 380;
const HEIGHT = 170;
const TOP_OFFSET = 60;

export interface ReminderPayload {
  elapsedSec: number;
  overSec: number;
  isCalendar: boolean;
  // "duration"(기본) = 예정 종료 시각 리마인더(알림만). "cap" = 절대 상한 경고. "silence" = 무음 지속 경고.
  // cap·silence는 무반응 시 자동 종료. 창은 kind로 문구·버튼 라벨을 분기하고, snoozeMin으로 버튼 텍스트를 맞춘다.
  kind?: "duration" | "cap" | "silence";
  snoozeMin?: number;
}

// reminder 창의 사용자 액션 — 메인의 리스너들이 kind로 자기 종류만 처리하도록 함께 실어 보낸다.
export interface ReminderAction {
  action: "stop" | "snooze";
  kind: "duration" | "cap" | "silence";
}

// 윈도우 인스턴스 캐시. 동시 다중 init 호출 방어 + 이미 만들어진 경우 재사용.
let initPromise: Promise<void> | null = null;

// 회의 시작 시 호출 — visible:false로 백그라운드 webview 준비.
// 다음 트리거가 1분 뒤라면 그동안 React 마운트/페인트가 모두 끝나 깜빡임 없는 show가 가능.
export function initReminderWindow(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const existing = await WebviewWindow.getByLabel(REMINDER_LABEL);
    if (existing) return;

    new WebviewWindow(REMINDER_LABEL, {
      url: `/index.html?w=reminder`,
      width: WIDTH,
      height: HEIGHT,
      // 화면 밖 좌표로 두면 visible:false가 안 먹는 환경에서도 사용자에게 안 보임.
      x: -10000,
      y: -10000,
      resizable: false,
      decorations: false,
      // 투명은 macOSPrivateApi:true(tauri.conf.json) + macos-private-api feature(Cargo.toml) +
      // transparent:true 조합으로 달성. 라운드 코너 바깥의 검정은 사실 html/body 배경이 비친
      // 것이라 reminderWindow.css에서 html.reminder-mode까지 투명 처리해 해결. 라운드/그림자는 CSS.
      transparent: true,
      visible: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      visibleOnAllWorkspaces: true,
      focus: false,
      shadow: false,
      title: "Junmit 녹음 알림",
    });
  })();

  return initPromise;
}

// 트리거 시 호출 — 데이터 emit + 활성 모니터 상단 중앙으로 이동 + show.
export async function showReminderWindow(payload: ReminderPayload): Promise<void> {
  try {
    await initReminderWindow();
    let win = await WebviewWindow.getByLabel(REMINDER_LABEL);
    if (!win) {
      // 사용자가 시스템 단축키(Cmd+W) 등으로 close한 케이스 — 캐시 무효화 후 재생성
      console.warn("[reminder] showReminderWindow: 윈도우 없음 — 재생성");
      initPromise = null;
      await initReminderWindow();
      win = await WebviewWindow.getByLabel(REMINDER_LABEL);
      if (!win) {
        console.warn("[reminder] showReminderWindow: 재생성 실패");
        return;
      }
    }

    // 데이터를 webview에 먼저 전달 — show 전에 React state가 갱신되도록.
    await emit("reminder:data", payload);

    // 활성 모니터 기준 상단 중앙. currentMonitor가 null이면(멀티모니터 전환 등) primaryMonitor로 fallback.
    // 둘 다 null이면 안전 좌표(100,60) — 윈도우는 init 때 화면 밖(-10000)에 두므로 setPosition을
    // 반드시 호출해야 화면 안으로 들어온다 (스킵하면 화면 밖에 show되어 안 보임).
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    let x = 100;
    let y = TOP_OFFSET;
    if (monitor) {
      const scale = monitor.scaleFactor;
      const monitorWidthLogical = monitor.size.width / scale;
      const monitorXLogical = monitor.position.x / scale;
      const monitorYLogical = monitor.position.y / scale;
      x = monitorXLogical + (monitorWidthLogical - WIDTH) / 2;
      y = monitorYLogical + TOP_OFFSET;
    }
    await win.setPosition(new LogicalPosition(x, y));

    await win.show();
  } catch (e) {
    console.error("[reminder] showReminderWindow 실패:", e);
  }
}

// snooze/stop 또는 화면 언마운트 시 — 윈도우는 살려두고 hide만.
export async function hideReminderWindow(): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel(REMINDER_LABEL);
    if (win) await win.hide();
  } catch (e) {
    console.error("[reminder] hideReminderWindow 실패:", e);
  }
}
