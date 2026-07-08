// 익명 사용량 이벤트 — Aptabase(고유 사용자 식별자 없음, 프라이버시 우선).
// **회의 내용(제목·전사·회의록·참석자)은 절대 속성으로 넣지 않는다.** 카운트·카테고리·버킷만.
// 사용자가 진단·사용 통계 수집을 끄면(telemetry_enabled=false) 전송하지 않는다.
// dev 빌드에선 Aptabase 앱 키가 비어 있어(릴리스에서만 주입) 자연히 전송되지 않는다.
// 전송은 Rust 플러그인 command를 invoke로 직접 호출한다 — npm `@aptabase/tauri`는 Tauri v1 전용이라 v2 앱과 호환되지 않음.

import { invoke } from "@tauri-apps/api/core";
import { logError } from "./logging";

let enabledCache: boolean | null = null;

async function isEnabled(): Promise<boolean> {
  if (enabledCache !== null) return enabledCache;
  // 키 존재·release·사용자 동의를 Rust가 함께 판정 — dev/키없음이면 false라 trackEvent를 시도조차 안 함.
  enabledCache = await invoke<boolean>("cmd_analytics_active").catch(() => false);
  return enabledCache;
}

/** 설정 화면에서 토글을 바꾸면 호출 — 다음 track()이 새 값을 다시 읽게 한다. */
export function resetAnalyticsGate(): void {
  enabledCache = null;
}

/** 익명 사용량 이벤트 전송. 실패해도 무해(조용히 로그만). 내용성 값 금지. */
export async function track(
  name: string,
  props?: Record<string, string | number>
): Promise<void> {
  try {
    if (!(await isEnabled())) return;
    // Rust 플러그인(tauri-plugin-aptabase) command를 직접 호출한다.
    // npm `@aptabase/tauri`는 Tauri v1 IPC(window.__TAURI_IPC__)만 써서 v2 앱에선 매번 실패 →
    // v2 호환 경로인 invoke로 직접 부른다. 인자 이름(name/props)은 Rust command 시그니처와 일치.
    await invoke("plugin:aptabase|track_event", { name, props: props ?? null });
  } catch (e) {
    logError("analytics", e);
  }
}

/** 녹음 길이(초) → 버킷 문자열. 원값 대신 범주만 전송해 회의 식별 위험을 없앤다. */
export function durationBucket(seconds: number): string {
  if (seconds < 15 * 60) return "<15m";
  if (seconds < 30 * 60) return "15-30m";
  if (seconds < 60 * 60) return "30-60m";
  return ">60m";
}

/** 기본 3유형만 그대로, 사용자 정의 유형명은 "custom"으로 뭉갠다(유형명 유출 방지). */
export function meetingTypeCategory(type: string | undefined): string {
  const known = ["presentation", "note", "review", "auto"];
  return type && known.includes(type) ? type : "custom";
}
