import { invoke } from "@tauri-apps/api/core";
import type { Cli } from "@/types";
import { agentSkillTrigger } from "@/utils/spawn";

// 살아있는 PTY의 CLI TUI에 스킬 트리거 전송 (Tier 1 재사용 — 세션 컨텍스트 유지).
//
// \x01\x0b prefix — 사용자가 입력란에 텍스트를 입력 중이었다면 우리 명령과 결합되는 사고
// ("가나다라/meeting" 같은) 방지. cursor 위치 무관하게 현재 line 전체를 클리어:
//   \x01 (Ctrl+A) — cursor를 줄 시작으로 이동
//   \x0b (Ctrl+K) — cursor부터 줄 끝까지 삭제
// claude·codex 모두 readline 스타일 컴포저라 동일 동작이며 빈 입력에선 noop이라 안전.
// \x15(Ctrl+U) 단독은 cursor → 줄 시작만 삭제해 cursor가 중간일 때 뒷부분이 잔존하므로
// 더 견고한 조합 사용. multi-line 입력은 현재 line만 클리어되지만 회의 워크플로우에선 빈도 낮음.
//
// \r (CR) suffix — 두 TUI 모두 stdin의 \n이 아닌 \r을 enter로 인식.
//
// CLI별 차이: 입력 내용(claude=슬래시 커맨드, codex·antigravity=자연어 스킬 트리거 —
// spawn.ts agentSkillTrigger와 단일 소스) + 전송 방식. codex TUI는 한 read로 도착한
// 청크를 붙여넣기로 취급해 끝의 \r을 제출이 아닌 입력으로 처리한다(tmux 대조 실측: 단일
// 청크=입력란 잔류, 분리 전송=제출. claude는 단일 청크도 제출됨). 그래서 codex는
// 텍스트와 \r을 별개 write로 보내고, 사이 지연으로 PTY 버퍼에서 한 청크로 다시
// 합쳐지는 것을 방지한다(120ms 실측 검증).
// antigravity는 청크 처리 미실측이라 보수적으로 codex 경로(분리 전송)를 공유 — 단일 청크를
// 제출로 처리하는 TUI에서도 분리 전송은 무해하다(E2E에서 단일 청크 제출 확인 시 간소화 여지).
//
// 호출자는 슬래시(/) 포함된 명령 + 현재 cli를 넘긴다 (예: "/meeting", "/assist").
// cli 기본값 없음 — 빠뜨리면 codex에서 슬래시가 평문 입력되는 사고라 컴파일 타임에 차단.
export async function sendSlashCommand(slash: string, cli: Cli): Promise<void> {
  if (cli === "codex" || cli === "antigravity") {
    await invoke<void>("cmd_pty_input", { data: `\x01\x0b${agentSkillTrigger(slash)}` });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await invoke<void>("cmd_pty_input", { data: "\r" });
    return;
  }
  await invoke<void>("cmd_pty_input", { data: `\x01\x0b${slash}\r` });
}

// 살아있는 PTY 정리 — 의도적 종료라 실패는 무시(이미 죽었거나 PTY 없음). idempotent.
// 세션 전환·도우미 정리·화면 이탈 등 여러 곳에 흩어져 있던 동일 invoke를 단일화.
export async function killPty(): Promise<void> {
  await invoke<void>("cmd_pty_kill").catch(() => {});
}
