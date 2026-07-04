import { invoke } from "@tauri-apps/api/core";
import type { DepsCheck } from "@/types";

// CLI 선택 이후 진입 경로 결정 — AppShell 초기 게이트와 선택 화면이 공유(중복 로직 방지).
// 의존성(bin+번들 모델+venv+whisper)이 모두 있으면 홈, 아니면 setup.
export async function routeAfterCliSelected(): Promise<string> {
  try {
    const deps = await invoke<DepsCheck>("cmd_check_deps");
    if (deps.installed) return "/";
    // 기초 설치는 됐고 로컬 LLM 모델만 없으면 전용 "모델 준비" 화면으로 (온보딩 setup 재사용 X).
    // 그 외(기초 미설치)는 기초 설치 화면. mlx 온보딩은 base 설치 완료 후 이 조건으로 넘어온다.
    const missing = deps.missing ?? [];
    const onlyModelMissing = missing.length > 0 && missing.every((m) => m === "로컬 AI 모델");
    return onlyModelMissing ? "/local-model" : "/setup";
  } catch {
    return "/setup";
  }
}
