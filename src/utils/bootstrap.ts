import { invoke } from "@tauri-apps/api/core";
import type { DepsCheck } from "@/types";

// CLI 선택 이후 진입 경로 결정 — AppShell 초기 게이트와 선택 화면이 공유(중복 로직 방지).
// 의존성(bin+번들 모델+venv+whisper)이 모두 있으면 홈, 아니면 setup.
export async function routeAfterCliSelected(): Promise<string> {
  try {
    const deps = await invoke<DepsCheck>("cmd_check_deps");
    return deps.installed ? "/" : "/setup";
  } catch {
    return "/setup";
  }
}
