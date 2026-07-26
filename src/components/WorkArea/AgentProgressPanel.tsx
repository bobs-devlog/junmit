import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity } from "@/constants";
import { parseHeadlessLine } from "@/utils/headless";
import ProgressPanel from "./ProgressPanel";
import { capItems, type AgentState, type PanelItem, type Stage } from "./progressPanelModel";

interface AgentProgressPanelProps {
  // 현재 활동성 — 작업(Correcting/Composing) 진입 시 이전 실행의 표시를 비운다.
  activity: Activity;
  // 회의록 자기검증 진행 중 — 공개(phase_done→Idle) 후에도 작업이 이어지는 구간.
  verifying?: boolean;
  // 회의록 검증 토글(meeting.json notes_verification, 기본 ON) — 검증 단계 유무 결정.
  verifyEnabled?: boolean;
  // AI 다듬기 토글(meeting.json ai_polish, 기본 ON) — 다듬기 단계 유무 결정.
  // 단계 목록은 2(정보 확인·작성) + 다듬기 + 검증 = 2~4행.
  polishEnabled?: boolean;
  // phase_done 정상 완료 여부 — 크래시 회수는 null(completedActivity)이라 거짓 완료 없음.
  completed?: boolean;
  // 표시할 게 없고 작업 중도 아닐 때 보여줄 빈 상태 (EmptyState 재사용 — LocalProgressPanel과 동일).
  emptyState: React.ReactNode;
}

// ── 로그 목록 갱신 헬퍼 (순수 함수: 목록 in → 목록 out) ─────────────────────
// 리스너가 "이벤트 → 디스패치 한 줄"로 읽히도록 갱신 규칙을 이름 붙여 분리한다.

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

// 토글로 사전 확정되는 결정론 단계 목록. hint는 그 단계가 진행 중인 동안 지속 노출.
function stagePlan(
  polishEnabled: boolean,
  verifyEnabled: boolean
): { key: string; label: string; hint?: string }[] {
  return [
    { key: "prepare", label: "회의 정보 확인" },
    ...(polishEnabled
      ? [
          {
            key: "correct",
            label: "회의 내용 다듬기",
            hint: "녹음 분량에 따라 몇 분 걸릴 수 있어요",
          },
        ]
      : []),
    {
      key: "compose",
      label: "회의록 작성",
      hint: "그동안 전사본 탭에서 화자 이름을 확인·수정할 수 있어요",
    },
    ...(verifyEnabled
      ? [
          {
            key: "verify",
            label: "검증·마무리",
            hint: "회의록은 이미 열람할 수 있어요. 전사본 탭에서 화자 이름도 확인·수정해 보세요",
          },
        ]
      : []),
  ];
}

// 앱 상태 기반 단계 도출. Correcting 초반(첫 sub-agent 시작 전)은 모델이 회의 정보를 읽는
// 준비 구간이라 "회의 정보 확인"을 진행으로 표시한다(hasAgentStarted). 진행률 %는 총량을
// 모르는 LLM 작업이라 불가: 단계 행 수가 표현 상한.
function agentStages(
  activity: Activity,
  verifying: boolean,
  hasAgentStarted: boolean,
  polishEnabled: boolean,
  verifyEnabled: boolean,
  completed: boolean
): Stage[] {
  // verifying인데 verify 토글 OFF인 비정형 조합도 단계가 de facto 존재하므로 행을 만든다.
  const plan = stagePlan(polishEnabled, verifyEnabled || verifying);
  const currentKey = verifying
    ? "verify"
    : activity === Activity.Correcting
      ? // AI 다듬기 OFF면 다듬기 단계 자체가 없다 — correct 신호까지의 짧은 구간 전체를 정보
        // 확인으로 표시하고, codex의 working 신호(보조 작업)의 다듬기 오전환도 함께 차단.
        !polishEnabled || !hasAgentStarted
        ? "prepare"
        : "correct"
      : activity === Activity.Composing
        ? "compose"
        : null;
  if (currentKey == null) {
    // Idle: 정상 완료면 전 행 ✓ 유지, 취소·크래시면 카드를 접는다(로그가 경위를 말한다).
    return completed
      ? plan.map((stage) => ({ key: stage.key, label: stage.label, state: "done" as const }))
      : [];
  }
  const currentIndex = plan.findIndex((stage) => stage.key === currentKey);
  return plan.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    state: index < currentIndex ? "done" : index === currentIndex ? "running" : "pending",
    hint: index === currentIndex ? stage.hint : undefined,
  }));
}

/**
 * headless(claude -p / codex exec) 진행 패널 컨테이너: 이벤트 해석·단계 도출만 하고 렌더는
 * 셸에 위임. sub-agent 행은 claude 한정(codex는 스트림이 spawn을 노출하지 않아 요약 텍스트만).
 * 파싱·노이즈 판정은 utils/headless.parseHeadlessLine 단일 지점.
 */
export default function AgentProgressPanel({
  activity,
  verifying = false,
  verifyEnabled = true,
  polishEnabled = true,
  completed = false,
  emptyState,
}: AgentProgressPanelProps) {
  const [items, setItems] = useState<PanelItem[]>([]);
  const prevWorkingRef = useRef(false);
  // 이번 실행의 최종 result 수신 여부 — 작업 종료 시 미완 sub-agent 행의 완료/중단 판별 근거.
  // (result 없이 끝남 = 취소·크래시 → "중단됨")
  const resultSeenRef = useRef(false);

  // codex의 "보조 작업 가동 중" 신호(kind:"working") — codex는 sub-agent 행을 만들 수 없어
  // (파서 주석 참고) 단계 전환(정보 확인 → 다듬기) 근거로만 쓴다. claude는 agent 행이 같은 역할.
  const [workUnderway, setWorkUnderway] = useState(false);

  // 마지막 headless:event 도착 시각 — 파서가 버리는 이벤트도 생존 신호로 센다(리스너 최상단 갱신).
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const working = activity === Activity.Correcting || activity === Activity.Composing;
  const hasAgentStarted = workUnderway || items.some((item) => item.type === "agent");
  const stages = agentStages(
    activity,
    verifying,
    hasAgentStarted,
    polishEnabled,
    verifyEnabled,
    completed
  );
  const busy = stages.some((stage) => stage.state === "running");

  // 작업 진입(rising edge) 시 이전 실행 표시 정리 — Idle 복귀 후에도 결과는 잔존시킨다
  // (LocalProgressPanel과 동일 체감: drawer를 닫기 전까지 마지막 상태 확인 가능).
  useEffect(() => {
    if (!prevWorkingRef.current && working) {
      setItems([]);
      setLastEventAt(null);
      setWorkUnderway(false);
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
        } else if (parsed.kind === "working") {
          setWorkUnderway(true);
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

  return (
    <ProgressPanel
      stages={stages}
      items={items}
      lastEventAt={lastEventAt}
      completed={completed}
      ariaLabel="AI 작업 진행 상황"
      emptyState={emptyState}
    />
  );
}
