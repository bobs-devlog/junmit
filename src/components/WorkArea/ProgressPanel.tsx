import { Fragment, useEffect, useRef, useState } from "react";
import Spinner from "@/components/Spinner";
import type { AgentState, LogLine, Stage, StageState } from "./progressPanelModel";
import styles from "./ProgressPanel.module.css";

// 진행 패널 공용 셸(표시 전용). 이벤트 해석·단계 도출·아이템 갱신 규칙은 각 컨테이너 소관.

interface ProgressPanelProps {
  // 빈 배열이면 카드 숨김.
  stages: Stage[];
  // 결과 요약 전용 — sub-agent는 Stage.subtasks로 간다.
  items: LogLine[];
  // 마지막 이벤트 도착 시각(하트비트 기준).
  lastEventAt: number | null;
  // phase_done 정상 완료 여부. 완료 직후 빈 로그에서 빈 상태가 번쩍이는 것을 막는다.
  completed: boolean;
  ariaLabel: string;
  emptyState: React.ReactNode;
}

// 아이콘 래퍼가 aria-hidden이라 Spinner의 role=status 중복 낭독은 없다(srText가 전달).
const stageSpinner = <Spinner size={11} className={styles.spinnerAccent} />;

// 대기는 사이드바 스테퍼와 같은 점(·): 고리(○)는 스피너와 형태가 겹쳐 전부 대기처럼 읽힌다.
const STAGE_STATE_VIEW: Record<
  StageState,
  { className: string; icon: React.ReactNode; srText: string }
> = {
  pending: { className: styles.stagePending, icon: "·", srText: "대기" },
  running: { className: styles.stageRunning, icon: stageSpinner, srText: "진행 중" },
  done: { className: styles.stageDone, icon: "✓", srText: "완료" },
  canceled: { className: styles.stageCanceled, icon: "—", srText: "중단됨" },
};

const SUBTASK_STATE_VIEW: Record<
  AgentState,
  { className: string; icon: string; srText: string; suffix?: string }
> = {
  running: { className: styles.subTaskRunning, icon: "◦", srText: "진행 중" },
  done: { className: styles.subTaskDone, icon: "✓", srText: "완료" },
  canceled: { className: styles.subTaskCanceled, icon: "—", srText: "중단됨", suffix: " (중단됨)" },
};

// 1분 미만은 초, 이후는 "m분 s초".
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

// 15초 단위로 거칠게(초당 카운트업은 시선만 끈다).
function formatHeartbeat(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 15) return "방금";
  if (seconds < 60) return `${Math.floor(seconds / 15) * 15}초 전`;
  return `${Math.floor(seconds / 60)}분 전`;
}

/**
 * 진행 패널 셸: 체크리스트 카드(상단 고정) + 로그 박스(하단 스크롤).
 * 카드는 라이브 리전(role="log") 밖: 갱신되는 경과가 낭독 폭주를 일으키지 않게.
 */
export default function ProgressPanel({
  stages,
  items,
  lastEventAt,
  completed,
  ariaLabel,
  emptyState,
}: ProgressPanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const runningStage = stages.find((stage) => stage.state === "running");
  const busy = runningStage != null;

  // busy 동안만 1초 tick. 렌더에서 Date.now() 직접 호출은 impure라 state로 흘린다.
  const [now, setNow] = useState(() => Date.now());
  // 잠자기 복귀 방어: tick 간격이 크게 점프하면 침묵 경과가 실제 무응답이 아니므로 기준
  // 바닥을 올려 "N분 전" 오보를 막는다. lastEventAt은 prop이라 직접 리셋하지 못해 max 합성.
  const [silenceFloorAt, setSilenceFloorAt] = useState<number | null>(null);
  const prevTickRef = useRef(0);
  useEffect(() => {
    if (!busy) return;
    prevTickRef.current = Date.now();
    const timer = window.setInterval(() => {
      const currentMs = Date.now();
      if (currentMs - prevTickRef.current > 30_000) setSilenceFloorAt(currentMs);
      prevTickRef.current = currentMs;
      setNow(currentMs);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // 진행 단계 전환 시 경과 기준 리셋("렌더 중 상태 조정" 패턴). 기준을 tick state(now)로
  // 잡아 렌더 순수성 유지(오차 1초 이내 수용).
  const runningKey = runningStage?.key ?? null;
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [prevRunningKey, setPrevRunningKey] = useState<string | null>(runningKey);
  if (runningKey !== prevRunningKey) {
    setPrevRunningKey(runningKey);
    if (runningKey != null) setPhaseStartedAt(now);
  }

  // 새 항목 도착 시 로그 하단 고정 스크롤.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0 && stages.length === 0 && !completed) {
    return <>{emptyState}</>;
  }

  const heartbeatBase = lastEventAt != null ? Math.max(lastEventAt, silenceFloorAt ?? 0) : null;
  const silentMs = heartbeatBase != null ? Math.max(0, now - heartbeatBase) : 0;
  const quietSilence = silentMs > 90_000;

  return (
    <div className={styles.panel} aria-label={ariaLabel}>
      {stages.length > 0 && (
        <div className={styles.status}>
          {stages.map((stage) => {
            const view = STAGE_STATE_VIEW[stage.state];
            return (
              <Fragment key={stage.key}>
                {/* key=state: 상태 전환 시 remount로 색 플래시 재생 */}
                <div key={stage.state} className={`${styles.stageRow} ${view.className}`}>
                  <span className={styles.stageIcon} aria-hidden="true">
                    {view.icon}
                  </span>
                  {stage.label}
                  {stage.state === "running" && (
                    <span className={styles.elapsed}>{formatElapsed(now - phaseStartedAt)}</span>
                  )}
                  <span className={styles.srOnly}> {view.srText}</span>
                </div>
                {stage.state === "running" && stage.detail && (
                  <div className={styles.stageDetail}>{stage.detail}</div>
                )}
                {/* 카드가 아니라 이 묶음에만 aria-live — 경과가 같은 리전에 들면 초당 낭독된다.
                    비어 있어도 렌더하는 건 리전이 내용보다 먼저 DOM에 있어야 첫 항목이 낭독되기 때문. */}
                {stage.subtasks && (
                  <div aria-live="polite">
                    {stage.subtasks.map((task) => {
                      const taskView = SUBTASK_STATE_VIEW[task.state];
                      return (
                        <div key={task.id} className={`${styles.subTask} ${taskView.className}`}>
                          <span className={styles.subTaskIcon} aria-hidden="true">
                            {taskView.icon}
                          </span>
                          {task.label}
                          <span className={styles.srOnly}> {taskView.srText}</span>
                          {taskView.suffix && (
                            <span className={styles.canceledTag}>{taskView.suffix}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Fragment>
            );
          })}
          {/* 하트비트는 90초 침묵 시 안내로 승격 — 로그가 비어도 성립하는 완결 문장 사용. */}
          {(runningStage?.hint || (busy && lastEventAt != null)) && (
            <div className={styles.footer}>
              {busy && lastEventAt != null && (
                <span
                  className={
                    quietSilence ? `${styles.liveDot} ${styles.liveDotQuiet}` : styles.liveDot
                  }
                  aria-hidden="true"
                />
              )}
              <div className={styles.footerText}>
                {runningStage?.hint && <div className={styles.guide}>{runningStage.hint}</div>}
                {busy && lastEventAt != null && (
                  <div>
                    {quietSilence
                      ? `조용하지만 진행 중이에요 · 마지막 신호 ${formatHeartbeat(silentMs)} (긴 내용을 처리하는 동안은 신호가 뜸할 수 있어요)`
                      : `AI가 계속 작업 중이에요 · 마지막 신호 ${formatHeartbeat(silentMs)}`}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <div className={styles.logBox}>
        <div ref={bodyRef} className={styles.log} role="log">
          {items.map((item, index) => (
            <div key={index} className={styles.line}>
              {item.text}
            </div>
          ))}
          {busy && <div className={styles.cursor} aria-hidden="true" />}
        </div>
      </div>
    </div>
  );
}
