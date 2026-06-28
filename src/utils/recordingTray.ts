// 녹음 중 메뉴바 트레이 아이콘. 녹음 시작 시 생성, 중지 시 제거.
// 타이틀에 빨간 점 + 경과 타이머를 표시해 사용자가 풀스크린/다른 앱에 있어도 인지 가능.
//
// 메뉴 없이 인디케이터 전용 — MenuItem.action 콜백은 Tauri 2에서 listener race 버그
// (`listeners[eventId].handlerId` 에러)를 일으켜 v1에선 클릭 동작 제외.
// 클릭 시 메인 윈도우 포커스 같은 동작은 후속에서 글로벌 이벤트 listener로 추가 예정.

import { TrayIcon } from "@tauri-apps/api/tray";
import { defaultWindowIcon, getName } from "@tauri-apps/api/app";

const TRAY_ID = "app-recording-tray";

function formatTimer(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 녹음 중에만 사용하는 단일 트레이 인스턴스. 다중 호출 방어용 캐시.
let trayPromise: Promise<TrayIcon> | null = null;

async function buildTray(): Promise<TrayIcon> {
  const appName = await getName().catch(() => "Junmit");
  return await TrayIcon.new({
    id: TRAY_ID,
    icon: (await defaultWindowIcon()) ?? undefined,
    iconAsTemplate: false,
    title: `● ${formatTimer(0)}`,
    tooltip: `${appName} 녹음 중`,
  });
}

export async function ensureRecordingTray(): Promise<void> {
  if (!trayPromise) {
    trayPromise = buildTray();
  }
  try {
    await trayPromise;
  } catch (e) {
    console.error("[tray] 생성 실패:", e);
    trayPromise = null;
  }
}

export async function updateRecordingTrayTimer(elapsedSec: number): Promise<void> {
  if (!trayPromise) return;
  try {
    const tray = await trayPromise;
    await tray.setTitle(`● ${formatTimer(elapsedSec)}`);
  } catch {}
}

export async function destroyRecordingTray(): Promise<void> {
  if (!trayPromise) return;
  const p = trayPromise;
  trayPromise = null;
  try {
    const tray = await p;
    await TrayIcon.removeById(tray.id);
  } catch {}
}
