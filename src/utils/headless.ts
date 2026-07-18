import { invoke } from "@tauri-apps/api/core";
import { killPty } from "@/utils/pty";

// headless 회의록 작성 이벤트 파서 — 단일 소스. Rust(cmd_run_headless_meeting)는 stdout
// JSONL을 파싱 없이 "headless:event"로 한 줄씩 중계하고, 의미 해석은 전부 여기서 한다
// (AgentProgressPanel·SessionContext가 공유). CLI별 해석은 parseClaudeEvent/parseCodexEvent가
// 나눠 갖는다 — 두 스키마의 type 값이 겹치지 않아 CLI 플래그 없이 판별된다.
//
// 표시 노이즈 필터도 여기서 담당(파서 = "사용자에게 보여줄 가치" 판정 단일 지점):
// 도구 호출의 영문 description은 스킬 프롬프트로 박멸 불가(실측)라 표시하지 않고, text는
// summaryLines 화이트리스트만 통과. ⏳ 단계 라인·TodoWrite도 드롭 — 단계 표시는 앱 상태
// 기반 상태 라인이 담당하며, 모델 출력에서 단계를 추론하면 누락·순서 역전마다 보정이
// 늘어난다(실측으로 확정).

export type HeadlessEvent =
  | { kind: "init"; sessionId: string; cli: "claude" | "codex" }
  | { kind: "agentStart"; id: string; label: string }
  | { kind: "agentDone"; id: string }
  | { kind: "working" } // codex 전용 — sub-agent 가동 사실만 아는 신호(라벨·개수 불명, parseCodexEvent 주석 참고).
  | { kind: "text"; text: string }
  | { kind: "result"; isError: boolean; text: string };

// 스킬이 고정한 sub-agent 식별자 → 한국어 라벨 (meeting/SKILL.md의 5종과 동기).
// 문구는 앱 화면 용어와 정렬(사이드바 "화자 구분"·탭 "전사본"·"회의 유형" 화면) — 스킬이
// description으로 지정하는 문구와 동일해야 한 작업이 두 이름을 갖지 않는다.
// 새 sub-agent가 추가되면 여기도 한 줄 추가 — 누락 시 "AI 보조 작업" 폴백이라 깨지진 않는다.
const SUBAGENT_LABELS: Record<string, string> = {
  "speaker-label-correction": "화자 구분 교정",
  "speaker-mapping": "화자 이름 매칭",
  "text-correction": "전사본 교정",
  "meeting-type-classification": "회의 유형 분류",
  "notes-verification": "회의록 검증",
};

// JSON 필드 접근용 최소 가드 — 미지 스키마에 관용적이어야 하므로 형태 검증은 쓰는 필드만.
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// 요약 텍스트 화이트리스트 — 스킬 출력 계약(resources/.claude/CLAUDE.md)상 사용자 대면
// 텍스트는 이모지 요약 블록(🎤·📋·✅…)과 그 목록 줄뿐이라, 계약 밖 산문은 한국어여도 드롭
// (블랙리스트로는 한국어 메타 발화를 못 거른다 — 실측). 블록에 요약과 중얼거림이 섞여 오는
// 경우가 있어 줄 단위로 판정. claude(assistant text)·codex(agent_message) 공용.
function summaryLines(blockText: string): string[] {
  const lines: string[] = [];
  for (const rawLine of blockText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // ⏳ 단계 라인은 드롭 — 단계 표시는 앱 상태 기반 상태 라인이 담당 (파일 헤더 주석).
    if (line.startsWith("⏳")) continue;
    const isSummary = /^\p{Extended_Pictographic}/u.test(line);
    const isListItem = /^([-–—•·]|\d+[.)])\s/.test(line);
    if ((isSummary || isListItem) && /[가-힣]/.test(line)) {
      lines.push(line);
    }
  }
  return lines;
}

// codex 오류 원문은 서버 오류 JSON을 문자열째 담는 경우가 있다(실측: 400 응답 passthrough).
// 실패 배너에 JSON 덩어리 대신 안쪽 message를 골라낸다 — JSON이 아니면 원문 유지.
function unwrapCodexError(message: string): string {
  try {
    const parsed = JSON.parse(message);
    const nested = isObj(parsed) && isObj(parsed.error) ? str(parsed.error.message) : "";
    return nested || message;
  } catch {
    return message;
  }
}

// claude(-p --output-format stream-json) 스키마 해석 — 2026-07 실측:
// - {type:"system",subtype:"init",session_id}                     → 세션 식별(/assist resume용)
// - {type:"system",subtype:"task_started",tool_use_id,description} → sub-agent 시작
// - {type:"system",subtype:"task_notification",tool_use_id}        → sub-agent 종료
// - {type:"assistant",message:{content:[{type:"text",...}]}}       → 스킬의 요약 텍스트
// - {type:"result",is_error,result}                                → 최종 판정
// 소유 타입이 아니면 null(디스패처가 codex로 넘김), 소유인데 낼 게 없으면 [] — 미지
// subtype(task_progress 등)에 관용해 CLI 업데이트에도 깨지지 않는다.
function parseClaudeEvent(streamEvent: Record<string, unknown>): HeadlessEvent[] | null {
  if (streamEvent.type === "system") {
    if (streamEvent.subtype === "init" && str(streamEvent.session_id)) {
      return [{ kind: "init", sessionId: str(streamEvent.session_id), cli: "claude" }];
    }
    // sub-agent 생명주기 — tool_use_id로 시작/종료를 짝짓는다(병렬 sub-agent 각각 추적).
    if (streamEvent.subtype === "task_started") {
      const id = str(streamEvent.tool_use_id);
      if (!id) return [];
      // 라벨 언어가 비결정적(description은 모델이 매번 짓는 자유 문자열 — 실측: 한 실행 한국어,
      // 다음 실행 영어) → 한국어 description만 신뢰하고, 아니면 스킬이 고정한 subagent_type
      // 식별자(meeting/SKILL.md 1단계·6단계 스펙)로 결정론 매핑한다.
      const description = str(streamEvent.description).trim();
      const label = /[가-힣]/.test(description)
        ? description
        : (SUBAGENT_LABELS[str(streamEvent.subagent_type)] ?? "AI 보조 작업");
      return [{ kind: "agentStart", id, label }];
    }
    if (streamEvent.subtype === "task_notification") {
      const id = str(streamEvent.tool_use_id);
      return id ? [{ kind: "agentDone", id }] : [];
    }
    return [];
  }

  if (streamEvent.type === "result") {
    return [
      { kind: "result", isError: Boolean(streamEvent.is_error), text: str(streamEvent.result) },
    ];
  }

  if (streamEvent.type === "assistant") {
    const blocks = isObj(streamEvent.message) ? streamEvent.message.content : null;
    if (!Array.isArray(blocks)) return [];
    const events: HeadlessEvent[] = [];
    for (const block of blocks) {
      if (!isObj(block)) continue;
      if (block.type === "text") {
        for (const line of summaryLines(str(block.text))) {
          events.push({ kind: "text", text: line });
        }
      }
      // tool_use는 표시하지 않는다 — sub-agent 시작/종료는 system/task_* 이벤트가 담당하고,
      // Bash·Read 등 개별 도구 호출은 영문 description 누수 + 저정보, TodoWrite는 발화가
      // 비결정적(실측: 실행마다 0~5건)이라 진행 표시 근거로 삼지 않는다.
    }
    return events;
  }

  return null;
}

// codex(exec --json) 스키마 해석 — 2026-07 실측(0.144.5):
// - {type:"thread.started",thread_id}                        → 세션 식별(/assist resume용)
// - {type:"item.completed",item:{type:"agent_message",text}} → 스킬의 요약 텍스트
// - {type:"item.started",item:{type:"collab_tool_call"}}     → sub-agent 대기 도구 호출
// - {type:"turn.completed"} / {type:"turn.failed",error} / {type:"error",message} → 최종 판정
//   (성공 본문 없음 — 요약은 마지막 agent_message가 담당)
// ⚠️ codex는 sub-agent 시작(spawn)을 스트림에 노출하지 않는다 — exec의 JSONL 변환기에
// SubAgentActivity 매핑이 없어 탈락(openai/codex 소스 확인, 0.144.5·main 동일. TUI는 그
// 아이템으로 진행 표시). 그래서 per-agent 행 대신 wait 호출을 working 신호로만 쓴다 —
// 업스트림이 매핑을 채우면 복원 재검토. 소유 타입 아니면 null, 낼 게 없으면 [](claude와 동일).
function parseCodexEvent(streamEvent: Record<string, unknown>): HeadlessEvent[] | null {
  if (streamEvent.type === "thread.started") {
    const threadId = str(streamEvent.thread_id);
    return threadId ? [{ kind: "init", sessionId: threadId, cli: "codex" }] : [];
  }

  // 실패 — error는 turn.failed 없이 단독으로 올 수 있어(기동 실패류) 둘 다 매핑.
  // 중복 도착은 표시 레이어의 동일 텍스트 dedupe가 흡수한다.
  if (streamEvent.type === "turn.failed" || streamEvent.type === "error") {
    const message =
      streamEvent.type === "error"
        ? str(streamEvent.message)
        : str(isObj(streamEvent.error) ? streamEvent.error.message : "");
    return [{ kind: "result", isError: true, text: unwrapCodexError(message) }];
  }

  // 성공 — 빈 text는 표시 레이어가 "✓ 작업 완료" 마감 줄로 채운다.
  if (streamEvent.type === "turn.completed") {
    return [{ kind: "result", isError: false, text: "" }];
  }

  if (
    (streamEvent.type === "item.started" || streamEvent.type === "item.completed") &&
    isObj(streamEvent.item)
  ) {
    const item = streamEvent.item;
    if (item.type === "collab_tool_call" && streamEvent.type === "item.started") {
      return [{ kind: "working" }];
    }
    if (item.type === "agent_message" && streamEvent.type === "item.completed") {
      return summaryLines(str(item.text)).map((text): HeadlessEvent => ({ kind: "text", text }));
    }
    return [];
  }

  return null;
}

// JSONL 한 줄 → 이벤트 목록. 두 스키마의 type 값이 겹치지 않아 claude → codex 순서로
// 물어보면 정확히 한쪽만 응답한다(둘 다 모르는 타입이면 드롭 — 미지 이벤트 관용).
export function parseHeadlessLine(raw: string): HeadlessEvent[] {
  let streamEvent: unknown;
  try {
    streamEvent = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObj(streamEvent)) return [];
  return parseClaudeEvent(streamEvent) ?? parseCodexEvent(streamEvent) ?? [];
}

// LLM 작업 취소 3종 묶음 — PTY(에이전트 TUI)·로컬(mlx)·headless(claude -p) 중 무엇이
// 돌고 있든 정리한다. 각 커맨드는 idempotent(없으면 noop)라 무조건 셋 다 호출해도 안전.
// 세션 전환·화면 이탈·명시 중단 등 취소 지점들이 공유한다.
export async function cancelMeetingWork(): Promise<void> {
  await Promise.allSettled([
    killPty(),
    invoke<void>("cmd_cancel_local_meeting").catch(() => {}),
    invoke<void>("cmd_cancel_headless_meeting").catch(() => {}),
  ]);
}

// headless 실행이 보존한 에이전트 대화 식별(agent_session.json: {cli, session_id}) —
// /assist 이어가기(claude --resume / codex resume) 재료. cli를 함께 저장해 회의 작성과 다른
// CLI로 이어가기를 시도하는 무의미한 resume(타 CLI의 id는 무효)을 호출자가 걸러낸다.
export type AgentSession = { cli: "claude" | "codex"; sessionId: string };

export async function writeAgentSession(sessionDir: string, s: AgentSession): Promise<void> {
  await invoke<void>("cmd_write_session_file", {
    sessionPath: sessionDir,
    filename: "agent_session.json",
    content: `${JSON.stringify({ cli: s.cli, session_id: s.sessionId })}\n`,
  }).catch(() => {});
}

// 파일 없음·파싱 실패·필드 부재는 전부 null(호출자가 fresh spawn 폴백).
export async function readAgentSession(sessionDir: string): Promise<AgentSession | null> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath: sessionDir,
    filename: "agent_session.json",
  }).catch(() => null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const cli = v?.cli === "claude" || v?.cli === "codex" ? v.cli : null;
    const sessionId = typeof v?.session_id === "string" && v.session_id ? v.session_id : null;
    return cli && sessionId ? { cli, sessionId } : null;
  } catch {
    return null;
  }
}

// 무효 id 정리 — resume PTY가 스폰 직후 죽은 경우(claude "No conversation found" / codex
// "ERROR: No saved session found") 호출해 다음 "AI에게 추가 요청"이 fresh spawn 폴백을 타게
// 한다. 삭제 커맨드가 없어 빈 객체로 덮어쓴다.
export async function clearAgentSession(sessionDir: string): Promise<void> {
  await invoke<void>("cmd_write_session_file", {
    sessionPath: sessionDir,
    filename: "agent_session.json",
    content: "{}\n",
  }).catch(() => {});
}
