import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity } from "@/constants";
import { parseHeadlessLine } from "@/utils/headless";
import styles from "./AgentProgressPanel.module.css";

interface AgentProgressPanelProps {
  // 현재 활동성 — 작업(Correcting/Composing) 진입 시 이전 실행의 표시를 비운다.
  activity: Activity;
  // 회의록 자기검증 진행 중 — 공개(phase_done→Idle) 후에도 작업이 이어지는 구간.
  verifying?: boolean;
  // 회의록 검증 토글(meeting.json notes_verification, 기본 ON) — 단계 분모(3/4단계) 결정.
  verifyEnabled?: boolean;
  // 표시할 게 없고 작업 중도 아닐 때 보여줄 빈 상태 (EmptyState 재사용 — LocalProgressPanel과 동일).
  emptyState: React.ReactNode;
}

// 진행 패널의 표시 항목 — 발생 순서대로 쌓이는 평평한 시간순 로그.
// 섹션(단계) 개념은 의도적으로 없다: 단계 구분을 모델 출력에서 추론하면 누락·표기 흔들림·
// 순서 역전(작성 요약이 신호 뒤에 오는 실측)마다 보정 로직이 늘어난다. "지금 어느 단계"는
// 앱 상태 기반 상태 라인(아래)이, "어떤 단계가 끝났나"는 사이드바 스테퍼가 담당하고,
// 결과 줄(🎤 화자 구분 교정 완료…)은 스스로 어떤 작업인지 말한다 — 헤더로 묶을 필요가 없다.
type AgentState = "running" | "done" | "canceled";
type PanelItem =
  // sub-agent 행 — id(tool_use_id)로 task_started(스피너)→task_notification(✓) 제자리 갱신.
  // 실행이 결과 없이 끝나면(취소·크래시) 미완 행은 ✓가 아니라 "중단됨"(—)으로 정리 — 일괄
  // ✓는 하다 만 작업을 완료로 표시하는 거짓이 된다. label은 화면 표시용(중복 시 "회의록 검증
  // 1"처럼 번호 부여), baseLabel은 번호 붙기 전 원본 — 병렬 형제 매칭 키.
  | { type: "agent"; id: string; baseLabel: string; label: string; state: AgentState }
  // 요약 텍스트 — 스킬의 이모지 결과 블록(🎤·📋·✅…) 한 줄.
  | { type: "text"; text: string };

const MAX_ITEMS = 200;

// ── 로그 목록 갱신 헬퍼 (순수 함수: 목록 in → 목록 out) ─────────────────────
// 리스너가 "이벤트 → 디스패치 한 줄"로 읽히도록 갱신 규칙을 이름 붙여 분리한다.

// 표시 상한 적용 — 오래된 항목부터 버린다(원문 전체는 headless.jsonl에 남아 손실 아님).
function capItems(items: PanelItem[]): PanelItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

// 진행 중(running) sub-agent 행 일괄 전환 — 정상 종료(done)와 취소·실패(canceled) 공용.
function settleRunningAgents(items: PanelItem[], settledState: AgentState): PanelItem[] {
  return items.map((item) =>
    item.type === "agent" && item.state === "running" ? { ...item, state: settledState } : item
  );
}

// 요약 텍스트 추가 — 직전과 동일한 줄 반복(모델 중복 출력)은 한 번만.
function appendText(items: PanelItem[], text: string): PanelItem[] {
  const last = items[items.length - 1];
  if (last?.type === "text" && last.text === text) return items;
  return capItems([...items, { type: "text", text }]);
}

// sub-agent 행 추가 — 같은 라벨의 병렬 형제(회의록 검증 2개 등)는 구분 없이 두 줄로 보이면
// 중복 표시처럼 오해되므로, 충돌 시 도착 순서로 번호를 붙인다(첫 행 "… 1" 소급 개명 포함).
function appendAgent(items: PanelItem[], id: string, baseLabel: string): PanelItem[] {
  const siblingCount = items.filter(
    (item) => item.type === "agent" && item.baseLabel === baseLabel
  ).length;
  const renamed =
    siblingCount === 1
      ? items.map((item) =>
          item.type === "agent" && item.baseLabel === baseLabel
            ? { ...item, label: `${baseLabel} 1` }
            : item
        )
      : items;
  const label = siblingCount > 0 ? `${baseLabel} ${siblingCount + 1}` : baseLabel;
  return capItems([...renamed, { type: "agent", id, baseLabel, label, state: "running" }]);
}

// 성공 result 반영 — 본문이 스킬 마지막 요약과 동일한 여러 줄로 오므로(실측) 줄 단위로 나눠
// 최근 항목에 이미 있는 줄은 거르고(이중 표시 방지), 진행 중 행은 완료로 정리한다.
function applySuccessResult(items: PanelItem[], resultText: string): PanelItem[] {
  const recentTexts = new Set(
    items.slice(-8).flatMap((item) => (item.type === "text" ? [item.text] : []))
  );
  const freshLines = (resultText || "✓ 작업 완료")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !recentTexts.has(line));
  return capItems([
    ...settleRunningAgents(items, "done"),
    ...freshLines.map((text) => ({ type: "text", text }) as PanelItem),
  ]);
}

// 소요 예측("보통 N분")은 표기하지 않는다 — 실행 시간이 서버 상태·모델·재시도에 따라 같은
// 분량에서도 2분~5분+로 흔들려, 빗나가는 예측은 표시하지 않는 것보다 신뢰를 깎는다. 패널의
// 모든 시간 표기는 측정된 사실(단계 경과·하트비트)만. 예측 도입은 pipeline.log의 headless
// 시작/종료 타임스탬프 분포가 수렴함이 확인된 뒤에만.

// 앱 상태 기반 현재 단계 상태 카드 — 모델 출력과 무관한 결정론 표시.
// Correcting은 스폰 순간부터 켜지지만 실제 처음 수십 초는 모델이 회의 정보를 읽는 준비
// 구간이라, 첫 sub-agent 시작(task_started — 하네스 이벤트) 전까지는 "회의 정보 확인"으로
// 표시한다(hasAgentStarted). stageNumber는 분모(검증 ON=4/OFF=3)와 함께 총량 감각을 준다
// (진행률 %는 총량을 모르는 LLM 작업이라 불가 — 단계 분모가 표현의 상한).
function phaseStatus(
  activity: Activity,
  verifying: boolean,
  hasAgentStarted: boolean
): { key: string; stageNumber: number; label: string; hint?: string } | null {
  if (verifying) {
    return {
      key: "verify",
      stageNumber: 4,
      label: "AI가 회의록을 검증하고 마무리하는 중",
      hint: "회의록은 이미 열람할 수 있어요. 전사본 탭에서 화자 이름도 확인·수정해 보세요",
    };
  }
  if (activity === Activity.Correcting) {
    if (!hasAgentStarted) {
      return { key: "prepare", stageNumber: 1, label: "AI가 회의 정보를 확인하는 중" };
    }
    return { key: "correct", stageNumber: 2, label: "AI가 회의 내용을 다듬는 중" };
  }
  if (activity === Activity.Composing) {
    return {
      key: "compose",
      stageNumber: 3,
      label: "AI가 회의록을 작성하는 중",
      hint: "그동안 전사본 탭에서 화자 이름을 확인·수정할 수 있어요",
    };
  }
  return null;
}

// 경과 시간 표기 — 1분 미만은 초, 이후는 "m분 s초".
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

// sub-agent 행의 상태별 표현 — 클래스·아이콘·낭독 텍스트·꼬리표의 단일 정의처.
// 상태가 늘거나 표현이 바뀔 때 렌더의 분기들을 일일이 고치지 않도록 여기 한 곳만 수정한다.
const AGENT_STATE_VIEW: Record<
  AgentState,
  { className: string; icon: React.ReactNode; srText: string; suffix?: string }
> = {
  running: {
    className: styles.agentRunning,
    icon: <span className={styles.spinner} />,
    srText: "진행 중",
  },
  done: { className: styles.agentDone, icon: "✓", srText: "완료" },
  canceled: { className: styles.agentCanceled, icon: "—", srText: "중단됨", suffix: " (중단됨)" },
};

// 하트비트 표기 — 15초 단위로 거칠게(초당 카운트업은 시선만 끈다).
function formatHeartbeat(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 15) return "방금";
  if (seconds < 60) return `${Math.floor(seconds / 15) * 15}초 전`;
  return `${Math.floor(seconds / 60)}분 전`;
}

/**
 * headless(claude -p) 진행 패널 — 터미널 드로어 자리에 들어가는 진행 표시.
 * - 상태 카드(상단 고정): 단계 (n/N) + 경과 + 안내 — Activity·isVerifying 기반 결정론.
 * - 로그(평평한 시간순): sub-agent 행(스피너 → ✓/— 제자리 전환)과 스킬의 한국어 요약 블록.
 * - 하트비트(하단 고정): 마지막 이벤트 도착 후 경과 — 스트림이 뜸한 구간의 "멈춤?" 불안 해소.
 * 파싱·노이즈 판정은 utils/headless.parseHeadlessLine 단일 지점, 여기선 표시만.
 */
export default function AgentProgressPanel({
  activity,
  verifying = false,
  verifyEnabled = true,
  emptyState,
}: AgentProgressPanelProps) {
  const [items, setItems] = useState<PanelItem[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const prevWorkingRef = useRef(false);
  // 이번 실행의 최종 result 수신 여부 — 작업 종료 시 미완 sub-agent 행의 완료/중단 판별 근거.
  // (result 없이 끝남 = 취소·크래시 → "중단됨")
  const resultSeenRef = useRef(false);

  const working = activity === Activity.Correcting || activity === Activity.Composing;
  const hasAgentStarted = items.some((item) => item.type === "agent");
  const status = phaseStatus(activity, verifying, hasAgentStarted);
  const busy = status !== null;

  // 현재 시각 tick — busy 동안만 1초 주기(정지 상태 비용 0). 경과·하트비트 표시의 공통 기준.
  // 렌더에서 Date.now() 직접 호출은 impure(React Compiler 규칙)라 state로 흘린다.
  const [now, setNow] = useState(() => Date.now());
  // 마지막 headless:event 도착 시각 — 파서가 버리는 이벤트도 생존 신호로 센다(리스너 최상단 갱신).
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const prevTickRef = useRef(0); // 렌더 중 Date.now() 금지(impure) — effect 시작 시 채움
  useEffect(() => {
    if (!busy) return;
    prevTickRef.current = Date.now();
    const timer = window.setInterval(() => {
      const currentMs = Date.now();
      // 잠자기 복귀 오탐 방어 — tick 간격이 크게 점프했으면(수면·프로세스 정지) 침묵 경과가
      // 실제 무응답이 아니므로 하트비트 기준을 리셋해 "N분 전" 오보를 막는다.
      if (currentMs - prevTickRef.current > 30_000) setLastEventAt(currentMs);
      prevTickRef.current = currentMs;
      setNow(currentMs);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // 단계 전환(key 변경) 시 단계 경과 기준 리셋 — effect 내 동기 setState 대신 "렌더 중 상태
  // 조정" 패턴(React 공인). 기준을 tick state(now)로 잡아 렌더 순수성 유지 — 오차 ≤1초는 수용.
  const statusKey = status?.key ?? null;
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [prevStatusKey, setPrevStatusKey] = useState<string | null>(statusKey);
  if (statusKey !== prevStatusKey) {
    setPrevStatusKey(statusKey);
    if (statusKey != null) setPhaseStartedAt(now);
  }

  // 작업 진입(rising edge) 시 이전 실행 표시 정리 — Idle 복귀 후에도 결과는 잔존시킨다
  // (LocalProgressPanel과 동일 체감: drawer를 닫기 전까지 마지막 상태 확인 가능).
  useEffect(() => {
    if (!prevWorkingRef.current && working) {
      setItems([]);
      setLastEventAt(null);
      resultSeenRef.current = false;
    }
    prevWorkingRef.current = working;
  }, [working]);

  // 작업 종료 시 미완 sub-agent 행 정리 — result를 받은 정상 종료면 완료(✓), result 없이
  // 끝났으면(취소·크래시) "중단됨"(—). 프로세스가 끝났으니 어느 쪽이든 스피너는 남지 않는다.
  const prevBusyRef = useRef(false);
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      setItems((prev) => settleRunningAgents(prev, resultSeenRef.current ? "done" : "canceled"));
    }
    prevBusyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("headless:event", (event) => {
      setLastEventAt(Date.now()); // 파싱 결과와 무관한 생존 신호 — 하트비트 기준
      for (const parsed of parseHeadlessLine(event.payload)) {
        if (parsed.kind === "agentStart") {
          setItems((prev) => appendAgent(prev, parsed.id, parsed.label));
        } else if (parsed.kind === "agentDone") {
          setItems((prev) =>
            prev.map((item) =>
              item.type === "agent" && item.id === parsed.id ? { ...item, state: "done" } : item
            )
          );
        } else if (parsed.kind === "text") {
          setItems((prev) => appendText(prev, parsed.text));
        } else if (parsed.kind === "result") {
          resultSeenRef.current = !parsed.isError;
          if (parsed.isError) {
            // 에러 원문은 영문이어도 전부 표시(실패 원인 파악 우선) + 미완 행은 중단 처리.
            setItems((prev) =>
              appendText(
                settleRunningAgents(prev, "canceled"),
                `⚠ ${parsed.text || "작업이 실패했어요"}`
              )
            );
          } else {
            setItems((prev) => applySuccessResult(prev, parsed.text));
          }
        }
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 새 항목 도착 시 로그 하단 고정 스크롤.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0 && !busy) {
    return <>{emptyState}</>;
  }

  const hint = !status
    ? undefined
    : status.key === "correct"
      ? "녹음 분량에 따라 몇 분 걸릴 수 있어요."
      : status.hint;
  const totalStages = verifyEnabled ? 4 : 3;
  const silentMs = lastEventAt != null ? now - lastEventAt : 0;

  return (
    <div className={styles.panel} aria-label="AI 작업 진행 상황">
      {/* 현재 단계 상태 라인 — 앱 상태 기반 결정론 표시. 작업 시작 즉시 나타나므로
          첫 스트림 출력까지의 공백(프로세스 기동 + 모델 첫 토큰)도 이 줄이 채운다.
          라이브 리전(role="log") 밖 — 초당 갱신되는 경과가 낭독 폭주를 일으키지 않게. */}
      {status && (
        <div className={styles.status}>
          <div className={styles.statusLabel}>
            <span className={styles.statusIcon} aria-hidden="true">
              <span className={styles.spinner} />
            </span>
            {status.label} ({status.stageNumber}/{totalStages})
            <span className={styles.elapsed}>{formatElapsed(now - phaseStartedAt)}</span>
          </div>
          {hint && <div className={styles.statusHint}>{hint}</div>}
        </div>
      )}
      <div ref={bodyRef} className={styles.log} role="log">
        {items.map((item, index) => {
          if (item.type === "text") {
            return (
              <div key={index} className={styles.line}>
                {item.text}
              </div>
            );
          }
          const view = AGENT_STATE_VIEW[item.state];
          return (
            <div key={item.id} className={view.className}>
              <span className={styles.agentIcon} aria-hidden="true">
                {view.icon}
              </span>
              {item.label}
              <span className={styles.srOnly}> {view.srText}</span>
              {view.suffix && <span className={styles.canceledTag}>{view.suffix}</span>}
            </div>
          );
        })}
      </div>
      {/* 하트비트 — 스트림 이벤트가 뜸한 구간(모델이 긴 텍스트를 처리 중)의 생존 신호.
          라이브 리전 밖 하단 고정. 90초 침묵 시 안내로 승격. */}
      {busy && lastEventAt != null && (
        <div className={styles.heartbeat}>
          {silentMs > 90_000
            ? `조용하지만 진행 중이에요.. 마지막 활동 ${formatHeartbeat(silentMs)} (긴 내용을 처리하는 동안은 출력이 뜸할 수 있어요)`
            : `마지막 활동 · ${formatHeartbeat(silentMs)}`}
        </div>
      )}
    </div>
  );
}
