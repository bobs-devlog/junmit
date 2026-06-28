import clsx from "clsx";
import { Activity, Step, STEPS, activityMeta } from "@/constants";
import type { StepId } from "@/constants";
import type { ConfluencePublishMode, SessionSteps } from "@/types";
import Spinner from "@/components/Spinner";
import styles from "./Sidebar.module.css";

// Activity별 stepper 진행(스피너) 표시 단계 결정.
function activeStepFor(
  activity: Activity,
  currentStepId: StepId | null,
  _steps: SessionSteps
): StepId | null {
  if (activity === Activity.Processing) return currentStepId;
  if (activity === Activity.Correcting) return Step.Correct;
  if (activity === Activity.Composing) return Step.Notes;
  if (activity === Activity.Publishing) return Step.Publish;
  return null;
}

interface Props {
  activity: Activity; // Idle / Saving / Processing / Correcting / Composing / Publishing (Recording은 RecordingSidebarControls)
  steps: SessionSteps;
  currentStepId: StepId | null;
  // publish.json.confluence.mode — published 상태에서 "Confluence 열기" 노출 분기에 사용.
  // create만 외부 페이지 URL 보유. append/skip은 시스템이 외부 URL 모르므로 버튼 미노출.
  publishMode: ConfluencePublishMode;
  // 핸들러 — 화면이 직접 closure로 작성. 사용 안 하는 것은 noop으로 받지 말고 화면이 책임지고 전달.
  onAbort: () => void; // Saving/Processing/Composing/Publishing 진행 중 중단 (PTY kill + 화면 reset)
  onStartProcessing: () => void; // idle + transcribed=false
  onResumeProcessing: () => void; // idle + transcribed=true, diarized=false
  onComposeNotes: () => void; // idle + diarized=true, notes_written=false
  onPublish: () => void; // idle + notes_written=true (review 또는 republish)
  onOpenConfluence: () => void; // idle + published=true + mode=create
  onRequestAi: () => void; // idle + notes_written=true (자유 추가 요청 — panel expand + 필요시 spawn)
  onForceCompose: () => void; // idle + no_speech (escape hatch — 무음 판정 무효화 후 재개)
  onResetSession: () => void; // dev 전용: 녹음 끝난 시점으로 초기화 (처리 산출물 삭제)
  onResetToDiarized: () => void; // dev 전용: 화자분리 시점으로 초기화 (/meeting 산출물만 삭제)
}

// Session 화면(녹음 외 단계)의 사이드바 콘텐츠. SessionScreen이 portal로 주입.
export default function SessionSidebarControls({
  activity,
  steps,
  currentStepId,
  publishMode,
  onAbort,
  onStartProcessing,
  onResumeProcessing,
  onComposeNotes,
  onPublish,
  onOpenConfluence,
  onRequestAi,
  onForceCompose,
  onResetSession,
  onResetToDiarized,
}: Props) {
  const meta = activityMeta(activity);
  const activeStep = activeStepFor(activity, currentStepId, steps);

  // 자동 진행 중 (Saving/Processing/Correcting/Composing/Publishing) — 중단만 노출.
  const isActiveWork =
    activity === Activity.Saving ||
    activity === Activity.Processing ||
    activity === Activity.Correcting ||
    activity === Activity.Composing ||
    activity === Activity.Publishing;

  return (
    <>
      <div className={styles.controls}>
        {/* 상태 라벨 */}
        <div className={clsx(styles.status, styles[meta.tone])} data-tone={meta.tone}>
          <span className={styles.statusDot} />
          <span>{meta.label}</span>
        </div>

        {/* Stepper — 모든 활동성에서 노출 (Recording 제외, 이건 별도 화면) */}
        <div className={styles.processSteps}>
          {STEPS.map((step) => {
            const isDone = steps[step.field];
            const isCurrent = step.id === activeStep;
            return (
              <div
                key={step.id}
                className={clsx(
                  styles.processStep,
                  isDone && styles.done,
                  isCurrent && styles.current
                )}
              >
                <span className={styles.processStepIcon}>
                  {isDone ? "✓" : isCurrent ? <Spinner size={11} /> : "·"}
                </span>
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>

        {/* 자동 진행 중 — 중단 버튼 */}
        {isActiveWork && (
          <button className="btn btn-danger" onClick={onAbort}>
            중단
          </button>
        )}

        {/* Idle — steps에 따라 다음 단계 액션 + 보조 액션 */}
        {activity === Activity.Idle && (
          <>
            <IdleActions
              steps={steps}
              publishMode={publishMode}
              onStartProcessing={onStartProcessing}
              onResumeProcessing={onResumeProcessing}
              onComposeNotes={onComposeNotes}
              onPublish={onPublish}
              onOpenConfluence={onOpenConfluence}
              onRequestAi={onRequestAi}
              onForceCompose={onForceCompose}
            />
            {/* dev 전용: 처리된 세션을 녹음 끝난 시점으로 되돌려 전사·화자분리 재실행.
                import.meta.env.DEV는 app-dev(Vite dev)에서만 true → release/app-build 미노출. */}
            {import.meta.env.DEV && steps.transcribed && (
              <button className="btn btn-danger" onClick={onResetSession}>
                [dev] 녹음 시점으로 초기화
              </button>
            )}
            {/* dev 전용: 화자분리 보존, /meeting 산출물만 삭제 → 느린 전사·화자분리 없이 회의록 재실행. */}
            {import.meta.env.DEV && steps.diarized && (
              <button className="btn btn-danger" onClick={onResetToDiarized}>
                [dev] 화자분리 시점으로 초기화
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

interface IdleProps {
  steps: SessionSteps;
  publishMode: ConfluencePublishMode;
  onStartProcessing: () => void;
  onResumeProcessing: () => void;
  onComposeNotes: () => void;
  onPublish: () => void;
  onOpenConfluence: () => void;
  onRequestAi: () => void;
  onForceCompose: () => void;
}

// idle 상태에서 진척도별 다음 단계 액션. 분기 로직을 별도 컴포넌트로 분리해 가독성 ↑.
// "AI에게 추가 요청" 보조 버튼은 회의록 작성 후(notes_written) 분기에만 노출 —
// 그 전엔 자유 대화할 컨텍스트가 부족해 사이드바 정형 흐름이 우선.
function IdleActions({
  steps,
  publishMode,
  onStartProcessing,
  onResumeProcessing,
  onComposeNotes,
  onPublish,
  onOpenConfluence,
  onRequestAi,
  onForceCompose,
}: IdleProps) {
  if (steps.published) {
    // create 모드만 외부 페이지 URL 보유 → "Confluence 열기" 노출.
    // append/skip은 시스템이 외부 URL 모르므로 "다시 등록"을 Primary로 승격.
    if (publishMode === "create") {
      return (
        <>
          <button className="btn btn-primary btn-large" onClick={onOpenConfluence}>
            Confluence 열기
          </button>
          <button className="btn btn-secondary" onClick={onPublish}>
            다시 등록
          </button>
          <button className="btn btn-secondary" onClick={onRequestAi}>
            AI에게 추가 요청
          </button>
        </>
      );
    }
    return (
      <>
        <button className="btn btn-primary btn-large" onClick={onPublish}>
          다시 등록
        </button>
        <button className="btn btn-secondary" onClick={onRequestAi}>
          AI에게 추가 요청
        </button>
      </>
    );
  }
  if (steps.notes_written) {
    return (
      <>
        <button className="btn btn-primary btn-large" onClick={onPublish}>
          Confluence 등록
        </button>
        <button className="btn btn-secondary" onClick={onRequestAi}>
          AI에게 추가 요청
        </button>
      </>
    );
  }
  // 무음("발화 없음") — diarize·회의록을 건너뛴 상태. 정형 흐름("처리 이어서 진행") 대신
  // escape hatch만 노출(그대로 진행하면 환각 세그먼트를 화자분리하게 됨).
  if (steps.no_speech) {
    return (
      <button className="btn btn-secondary btn-large" onClick={onForceCompose}>
        그래도 회의록 작성하기
      </button>
    );
  }
  if (!steps.transcribed) {
    return (
      <button className="btn btn-primary btn-large" onClick={onStartProcessing}>
        오디오 처리 시작
      </button>
    );
  }
  if (!steps.diarized) {
    return (
      <button className="btn btn-primary btn-large" onClick={onResumeProcessing}>
        처리 이어서 진행
      </button>
    );
  }
  // diarized=true && notes_written=false
  const label = steps.corrected ? "회의록 작성 (이어서)" : "회의록 작성";
  return (
    <button className="btn btn-primary btn-large" onClick={onComposeNotes}>
      {label}
    </button>
  );
}
