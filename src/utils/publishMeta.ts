// 세션 디렉토리의 publish.json read/write 유틸.
// publish.json은 발행 설정(사용자 입력) + 결과(LLM이 채우는 pageUrl, published 마킹)의 단일 진실 원천.
// 기존 confluence-url.txt를 대체.

import { invoke } from "@tauri-apps/api/core";
import type { PublishConfig, ConfluencePublishConfig } from "@/types";

// 새 회의의 default — 발행 미설정 상태. 사용자가 발행 탭에서 명시 선택해야 published 가능.
function defaultConfluence(): ConfluencePublishConfig {
  return { mode: "create", parentUrl: "", pageUrl: "", published: false };
}

export function defaultPublishConfig(): PublishConfig {
  return { confluence: defaultConfluence() };
}

export async function loadPublishConfig(sessionPath: string): Promise<PublishConfig> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath,
    filename: "publish.json",
  }).catch(() => null);
  if (!raw) return defaultPublishConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<PublishConfig>;
    // 필드 누락 대비 — 부분 저장된 publish.json도 안전하게 로드.
    return {
      confluence: { ...defaultConfluence(), ...(parsed.confluence ?? {}) },
    };
  } catch {
    return defaultPublishConfig();
  }
}

export async function savePublishConfig(sessionPath: string, config: PublishConfig): Promise<void> {
  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: "publish.json",
    content: JSON.stringify(config, null, 2),
  });
}

/** publish.json의 일부 필드만 갱신 (다른 필드는 유지). */
export async function updatePublishConfig(
  sessionPath: string,
  patch: Partial<PublishConfig>
): Promise<PublishConfig> {
  const current = await loadPublishConfig(sessionPath);
  const next: PublishConfig = {
    confluence: { ...current.confluence, ...(patch.confluence ?? {}) },
  };
  await savePublishConfig(sessionPath, next);
  return next;
}
