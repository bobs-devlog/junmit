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
  // 표시할 게 없고 작업 중도 아닐 때 보여줄 빈 상태 (EmptyState 재사용 — LocalProgressPanel과 동일).
  emptyState: React.ReactNode;
}

// 진행 패널의 표시 항목 — 발생 순서대로 쌓이는 평평한 시간순 로그.
// 섹션(단계) 개념은 의도적으로 없다: 단계 구분을 모델 출력에서 추론하면 누락·표기 흔들림·
// 순서 역전(작성 요약이 신호 뒤에 오는 실측)마다 보정 로직이 늘어난다. "지금 어느 단계"는
// 앱 상태 기반 상태 라인(아래)이, "어떤 단계가 끝났나"는 사이드바 스테퍼가 담당하고,
// 결과 줄(🎤 화자 구분 교정 완료…)은 스스로 어떤 작업인지 말한다 — 헤더로 묶을 필요가 없다.
type PanelItem =
  // sub-agent 행 — id(tool_use_id)로 task_started(스피너)→task_notification(✓) 제자리 갱신.
  // label은 화면 표시용(중복 시 "회의록 검증 1"처럼 번호 부여), baseLabel은 번호 붙기 전
  // 원본 — 같은 라벨의 병렬 형제가 나중에 도착했을 때 매칭하는 키.
  | { type: "agent"; id: string; baseLabel: string; label: string; done: boolean }
  // 요약 텍스트 — 스킬의 이모지 결과 블록(🎤·📋·✅…) 한 줄.
  | { type: "text"; text: string };

const MAX_ITEMS = 200;

// 앱 상태 기반 현재 단계 상태 라인 — 모델 출력과 무관한 결정론 표시.
// Correcting은 스폰 순간부터 켜지지만 실제 처음 수십 초는 모델이 회의 정보를 읽는 준비
// 구간이라, 첫 sub-agent 시작(task_started — 하네스 이벤트) 전까지는 "회의 정보 확인"으로
// 표시한다(hasAgentStarted). hint는 그 단계 동안 지속 노출되는 안내: 다듬기=최장 구간 사전
// 고지(전사 텍스트 교정이 long pole — 552줄 ~3분 실측), 작성·검증=correct 신호부터 화자
// 매핑 편집이 가능함을 유도.
function phaseStatus(
  activity: Activity,
  verifying: boolean,
  hasAgentStarted: boolean
): { key: string; label: string; hint?: string } | null {
  if (verifying) {
    return {
      key: "verify",
      label: "AI가 회의록을 검증하고 마무리하는 중",
      hint: "그동안 전사본 탭에서 화자 이름을 확인·수정할 수 있어요",
    };
  }
  if (activity === Activity.Correcting) {
    if (!hasAgentStarted) {
      return { key: "prepare", label: "AI가 회의 정보를 확인하는 중" };
    }
    return {
      key: "correct",
      label: "AI가 회의 내용을 다듬는 중",
      hint: "녹음 분량에 따라 몇 분 걸릴 수 있어요",
    };
  }
  if (activity === Activity.Composing) {
    return {
      key: "compose",
      label: "AI가 회의록을 작성하는 중",
      hint: "그동안 전사본 탭에서 화자 이름을 확인·수정할 수 있어요",
    };
  }
  return null;
}

// 경과 시간 표기 — 1분 미만은 초, 이후는 "m분 s초".
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

/**
 * headless(claude -p) 진행 패널 — 터미널 드로어 자리에 들어가는 진행 표시.
 * - 상태 라인(상단 고정): 현재 단계 + 경과 시간 + 안내 — Activity·isVerifying 기반 결정론.
 * - 로그(평평한 시간순): sub-agent 행(task_started/notification — 스피너 → ✓ 제자리 전환)과
 *   스킬의 한국어 요약 블록. 영문·산문 누수는 파서가 걸렀다.
 * 파싱·노이즈 판정은 utils/headless.parseHeadlessLine 단일 지점, 여기선 표시만.
 */
export default function AgentProgressPanel({
  activity,
  verifying = false,
  emptyState,
}: AgentProgressPanelProps) {
  const [items, setItems] = useState<PanelItem[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const prevWorkingRef = useRef(false);

  const working = activity === Activity.Correcting || activity === Activity.Composing;
  const hasAgentStarted = items.some((it) => it.type === "agent");
  const status = phaseStatus(activity, verifying, hasAgentStarted);
  const busy = status !== null;

  // 작업 진입(rising edge) 시 이전 실행 표시 정리 — Idle 복귀 후에도 결과는 잔존시킨다
  // (LocalProgressPanel과 동일 체감: drawer를 닫기 전까지 마지막 상태 확인 가능).
  useEffect(() => {
    if (!prevWorkingRef.current && working) setItems([]);
    prevWorkingRef.current = working;
  }, [working]);

  // 작업 종료 시 완료 신호를 놓친 sub-agent 행 정리 — 프로세스가 끝났으니 도는 것은 없다.
  const prevBusyRef = useRef(false);
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      setItems((prev) =>
        prev.map((it) => (it.type === "agent" && !it.done ? { ...it, done: true } : it))
      );
    }
    prevBusyRef.current = busy;
  }, [busy]);

  // 현재 단계의 경과 시간 — busy 동안만 1초 tick으로 현재 시각을 state에 흘린다
  // (렌더에서 Date.now() 직접 호출은 impure — React Compiler 규칙).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [busy]);
  // 단계 전환(key 변경) 시 기준 시각 리셋 — effect 내 동기 setState 대신 "렌더 중 상태 조정"
  // 패턴(React 공인). 기준을 tick state(now)로 잡아 렌더 순수성 유지 — 오차 ≤1초는 수용.
  const statusKey = status?.key ?? null;
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [prevStatusKey, setPrevStatusKey] = useState<string | null>(statusKey);
  if (statusKey !== prevStatusKey) {
    setPrevStatusKey(statusKey);
    if (statusKey != null) setPhaseStartedAt(now);
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const push = (item: PanelItem) =>
      setItems((prev) => {
        // 직전과 동일한 텍스트 반복(모델 중복 출력)은 한 번만.
        const last = prev[prev.length - 1];
        if (item.type === "text" && last?.type === "text" && last.text === item.text) {
          return prev;
        }
        const next = [...prev, item];
        return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
      });

    listen<string>("headless:event", (event) => {
      for (const ev of parseHeadlessLine(event.payload)) {
        if (ev.kind === "agentStart") {
          // 같은 라벨의 병렬 sub-agent(회의록 검증 2개)는 구분 없이 두 줄로 보이면 중복
          // 표시처럼 오해된다 — 충돌 시 도착 순서로 번호를 붙인다("회의록 검증 1"·"회의록 검증 2").
          setItems((prev) => {
            const siblings = prev.filter((it) => it.type === "agent" && it.baseLabel === ev.label);
            let renamed = prev;
            if (siblings.length === 1) {
              renamed = prev.map((it) =>
                it.type === "agent" && it.baseLabel === ev.label
                  ? { ...it, label: `${ev.label} 1` }
                  : it
              );
            }
            const label = siblings.length > 0 ? `${ev.label} ${siblings.length + 1}` : ev.label;
            const next: PanelItem[] = [
              ...renamed,
              { type: "agent", id: ev.id, baseLabel: ev.label, label, done: false },
            ];
            return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
          });
        } else if (ev.kind === "agentDone") {
          setItems((prev) =>
            prev.map((it) => (it.type === "agent" && it.id === ev.id ? { ...it, done: true } : it))
          );
        } else if (ev.kind === "text") {
          push({ type: "text", text: ev.text });
        } else if (ev.kind === "result") {
          // 성공 result 본문은 스킬의 마지막 요약과 동일한 여러 줄 텍스트로 온다(실측) —
          // 줄 단위로 나눠 최근 항목에 이미 있는 줄은 걸러 이중 표시를 막는다.
          // 에러는 원문이 영문이어도 전부 표시(실패 원인 파악이 우선).
          if (ev.isError) {
            push({ type: "text", text: `⚠ ${ev.text || "작업이 실패했어요"}` });
          } else {
            setItems((prev) => {
              const recent = new Set(
                prev.slice(-8).flatMap((it) => (it.type === "text" ? [it.text] : []))
              );
              const fresh = (ev.text || "✓ 작업 완료")
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l && !recent.has(l));
              const settled = prev.map((it) =>
                it.type === "agent" && !it.done ? { ...it, done: true } : it
              );
              const next = [
                ...settled,
                ...fresh.map((text) => ({ type: "text", text }) as PanelItem),
              ];
              return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
            });
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

  return (
    <div className={styles.panel} role="log" aria-label="AI 작업 진행 상황">
      {/* 현재 단계 상태 라인 — 앱 상태 기반 결정론 표시. 작업 시작 즉시 나타나므로
          첫 스트림 출력까지의 공백(프로세스 기동 + 모델 첫 토큰)도 이 줄이 채운다. */}
      {status && (
        <div className={styles.status}>
          <div className={styles.statusLabel}>
            <span className={styles.statusIcon} aria-hidden="true">
              <span className={styles.spinner} />
            </span>
            {status.label}…
            <span className={styles.elapsed}>{formatElapsed(now - phaseStartedAt)}</span>
          </div>
          {status.hint && <div className={styles.statusHint}>{status.hint}</div>}
        </div>
      )}
      <div ref={bodyRef} className={styles.log}>
        {items.map((it, i) =>
          it.type === "agent" ? (
            <div key={it.id} className={it.done ? styles.agentDone : styles.agentRunning}>
              <span className={styles.agentIcon} aria-hidden="true">
                {it.done ? "✓" : <span className={styles.spinner} />}
              </span>
              {it.label}
            </div>
          ) : (
            <div key={i} className={styles.line}>
              {it.text}
            </div>
          )
        )}
      </div>
    </div>
  );
}
