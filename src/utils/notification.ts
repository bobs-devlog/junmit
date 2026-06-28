import {
  isPermissionGranted,
  requestPermission,
  sendNotification as sendTauriNotification,
} from "@tauri-apps/plugin-notification";

// macOS 알림 — 권한 보장 후 전송. 실패는 조용히 무시(알림 실패가 흐름을 막지 않음).
export async function sendNotification(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (granted) sendTauriNotification({ title, body });
  } catch {}
}
