import { invoke } from "@tauri-apps/api/core";
import { killPty } from "@/utils/pty";

// headless 회의록 작성(claude -p --output-format stream-json) 이벤트 파서 — 단일 소스.
// Rust(cmd_run_headless_meeting)는 stdout JSONL을 파싱 없이 "headless:event"로 한 줄씩
// 중계하고, 의미 해석은 전부 여기서 한다 (AgentProgressPanel·SessionContext가 공유).
//
// 스키마는 2026-07 실측(스파이크 + 실사용 stream 캡처 다수) 기준:
// - {type:"system",subtype:"init",session_id}                          → 세션 식별(/assist resume용)
// - {type:"system",subtype:"task_started",tool_use_id,description}      → sub-agent 시작
//   (description은 스킬이 지정한 한국어 라벨 — 이탈 시 subagent_type 매핑 폴백)
// - {type:"system",subtype:"task_notification",tool_use_id,status}      → sub-agent 종료
// - {type:"assistant",message:{content:[{type:"text",...}]}}            → 스킬의 요약 텍스트
// - {type:"result",is_error,result}                                     → 최종 판정
// 그 외 타입(user 도구 결과, thinking, TodoWrite·task_progress 등)은 버린다 — 미지 이벤트에
// 관용해 CLI 업데이트로 새 타입이 추가돼도 파서가 깨지지 않는다.
//
// 표시 노이즈 필터도 여기서 담당(파서 = "사용자에게 보여줄 가치" 판정 단일 지점):
// - Bash 등 도구의 영문 description은 표시하지 않는다 — 스킬 영어 누수는 프롬프트로 박멸
//   불가(실측 확정)라 앱 레이어 필터가 정답이고, headless는 렌더링을 앱이 소유해 가능해졌다.
// - text는 화이트리스트: 이모지 요약 블록(스킬 출력 계약)과 그 목록 줄 + 한글 포함만 통과.
//   계약 밖 산문(메타 발화·영문 중얼거림)은 한국어여도 드롭.
// - ⏳ 단계 라인·TodoWrite도 드롭 — 단계 표시는 앱 상태(Activity·isVerifying) 기반 상태
//   라인이 결정론으로 담당한다. 모델 출력에서 단계를 추론하면 누락·표기 흔들림·순서 역전
//   (작성 요약이 신호 뒤 도착)마다 보정이 필요해져 복잡도만 는다(실측으로 확정).

export type HeadlessEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "agentStart"; id: string; label: string }
  | { kind: "agentDone"; id: string }
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

export function parseHeadlessLine(raw: string): HeadlessEvent[] {
  let streamEvent: unknown;
  try {
    streamEvent = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObj(streamEvent)) return [];

  if (
    streamEvent.type === "system" &&
    streamEvent.subtype === "init" &&
    str(streamEvent.session_id)
  ) {
    return [{ kind: "init", sessionId: str(streamEvent.session_id) }];
  }

  // sub-agent 생명주기 — tool_use_id로 시작/종료를 짝짓는다(병렬 sub-agent 각각 추적).
  if (streamEvent.type === "system" && streamEvent.subtype === "task_started") {
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
  if (streamEvent.type === "system" && streamEvent.subtype === "task_notification") {
    const id = str(streamEvent.tool_use_id);
    return id ? [{ kind: "agentDone", id }] : [];
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
        // 여러 줄 텍스트 블록을 줄 단위로 나눠 각각 판정 — 한 블록에 요약과 중얼거림이
        // 섞여 오는 경우가 있어 블록 통째 드롭/통과 둘 다 부정확하다.
        //
        // 표시 기준은 **화이트리스트** — 스킬 출력 계약(resources/.claude/CLAUDE.md)상
        // 사용자 대면 텍스트는 이모지 요약 블록(🎤·📋·✅·⚠️…)과 그 목록 줄뿐이다.
        // 계약 밖 산문(메타 발화·내부 용어 노출)은 **한국어여도** 누수이므로 드롭 —
        // 블랙리스트(영문만 차단)로는 한국어 메타 발화를 못 거른다(실측). 최종 안내문은
        // result 이벤트 경로로 별도 표시되므로 여기서 떨어져도 잃지 않는다.
        for (const rawLine of str(block.text).split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          // ⏳ 단계 라인은 드롭 — 단계 표시는 앱 상태 기반 상태 라인이 담당 (파일 헤더 주석).
          if (line.startsWith("⏳")) continue;
          const isSummary = /^\p{Extended_Pictographic}/u.test(line);
          const isListItem = /^([-–—•·]|\d+[.)])\s/.test(line);
          if ((isSummary || isListItem) && /[가-힣]/.test(line)) {
            events.push({ kind: "text", text: line });
          }
        }
        continue;
      }
      // tool_use는 표시하지 않는다 — sub-agent 시작/종료는 system/task_* 이벤트가 담당하고,
      // Bash·Read 등 개별 도구 호출은 영문 description 누수 + 저정보, TodoWrite는 발화가
      // 비결정적(실측: 실행마다 0~5건)이라 진행 표시 근거로 삼지 않는다.
    }
    return events;
  }

  return [];
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

// headless 실행이 보존한 claude 대화 id(claude_session.json) 읽기 — /assist --resume 재료.
// 파일 없음·파싱 실패·id 부재는 전부 null(호출자가 fresh spawn 폴백).
export async function readClaudeSessionId(sessionDir: string): Promise<string | null> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath: sessionDir,
    filename: "claude_session.json",
  }).catch(() => null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v?.session_id === "string" && v.session_id ? v.session_id : null;
  } catch {
    return null;
  }
}

// 무효 id 정리 — resume PTY가 스폰 직후 죽은 경우("No conversation found") 호출해 다음
// "AI에게 추가 요청"이 fresh spawn 폴백을 타게 한다. 삭제 커맨드가 없어 빈 객체로 덮어쓴다.
export async function clearClaudeSessionId(sessionDir: string): Promise<void> {
  await invoke<void>("cmd_write_session_file", {
    sessionPath: sessionDir,
    filename: "claude_session.json",
    content: "{}\n",
  }).catch(() => {});
}
