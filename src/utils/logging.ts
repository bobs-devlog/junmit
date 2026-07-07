// 프론트엔드 진단 로깅 유틸 — plugin-log를 통해 ~/Library/Logs/app.junmit/ 파일 로그에 남긴다.
// 여태 대부분 .catch(() => {})로 삼켜지던 핵심 흐름의 에러를 최소 침습으로 기록한다.
// 원격 전송은 Sentry(Rust plugin)가 주입한 @sentry/browser가 window.onerror·unhandledrejection을
// 자동 후킹하므로 여기서 별도 전송 호출은 하지 않는다 — 로컬 파일 로그 전용.

import {
  error as logErrorTauri,
  warn as logWarnTauri,
  info as logInfoTauri,
} from "@tauri-apps/plugin-log";

function fmt(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 삼켜지던 catch를 파일 로그에 남긴다 — scope는 발생 위치 태그(예: "saveRecording"). */
export function logError(scope: string, err: unknown): void {
  void logErrorTauri(`[${scope}] ${fmt(err)}`);
}

export function logWarn(scope: string, msg: string): void {
  void logWarnTauri(`[${scope}] ${msg}`);
}

export function logInfo(scope: string, msg: string): void {
  void logInfoTauri(`[${scope}] ${msg}`);
}
