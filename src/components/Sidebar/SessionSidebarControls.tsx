import clsx from "clsx";
import { Activity, Step, activityMeta, cliHasAgent, stepsForCli } from "@/constants";
import type { StepId } from "@/constants";
import type { Cli, SessionSteps } from "@/types";
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
  return null;
}

interface Props {
  activity: Activity; // Idle / Saving / Processing / Correcting / Composing (Recording은 RecordingSidebarControls)
  steps: SessionSteps;
  currentStepId: StepId | null;
  // 활성 백엔드 — mlx(로컬 LLM)는 에이전트·MCP가 없어 stepper 단계와 추가 요청 버튼을 게이팅.
  cli: Cli;
  // 핸들러 — 화면이 직접 closure로 작성. 사용 안 하는 것은 noop으로 받지 말고 화면이 책임지고 전달.
  onAbort: () => void; // Saving/Processing/Composing 진행 중 중단 (PTY kill + 화면 reset)
  onStartProcessing: () => void; // idle + transcribed=false
  onResumeProcessing: () => void; // idle + transcribed=true, diarized=false
  onComposeNotes: () => void; // idle + diarized=true, notes_written=false
  onRequestAi: () => void; // idle + notes_written=true (자유 추가 요청 — panel expand + 필요시 spawn)
  onForceCompose: () => void; // idle + no_speech (escape hatch — 무음 판정 무효화 후 재개)
  onResetSession: () => void; // dev 전용: 녹음 끝난 시점으로 초기화 (처리 산출물 삭제)
  onResetToDiarized: () => void; // dev 전용: 화자분리 시점으로 초기화 (/meeting 산출물만 삭제)
  // 자동 작성 preflight가 로그인 만료를 감지하면 set된 CLI — 작성 버튼 위에 재로그인 안내 노출.
  loginExpiredCli: Cli | null;
  onGoLogin: () => void; // 재로그인 화면(/settings/ai-tool)으로 이동 — 검증된 로그인 흐름 재사용.
}

// Session 화면(녹음 외 단계)의 사이드바 콘텐츠. SessionScreen이 portal로 주입.
export default function SessionSidebarControls({
  activity,
  steps,
  currentStepId,
  cli,
  onAbort,
  onStartProcessing,
  onResumeProcessing,
  onComposeNotes,
  onRequestAi,
  onForceCompose,
  onResetSession,
  onResetToDiarized,
  loginExpiredCli,
  onGoLogin,
}: Props) {
  const meta = activityMeta(activity);
  const activeStep = activeStepFor(activity, currentStepId, steps);

  // 자동 진행 중 (Saving/Processing/Correcting/Composing) — 중단만 노출.
  const isActiveWork =
    activity === Activity.Saving ||
    activity === Activity.Processing ||
    activity === Activity.Correcting ||
    activity === Activity.Composing;

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
          {stepsForCli(cli).map((step) => {
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
              cli={cli}
              onStartProcessing={onStartProcessing}
              onResumeProcessing={onResumeProcessing}
              onComposeNotes={onComposeNotes}
              onRequestAi={onRequestAi}
              onForceCompose={onForceCompose}
              loginExpiredCli={loginExpiredCli}
              onGoLogin={onGoLogin}
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
  cli: Cli;
  onStartProcessing: () => void;
  onResumeProcessing: () => void;
  onComposeNotes: () => void;
  onRequestAi: () => void;
  onForceCompose: () => void;
  loginExpiredCli: Cli | null;
  onGoLogin: () => void;
}

// idle 상태에서 진척도별 다음 단계 액션. 분기 로직을 별도 컴포넌트로 분리해 가독성 ↑.
// "AI에게 추가 요청"은 회의록 작성 후(notes_written) 분기에만 노출 — 그 전엔 자유 대화할
// 컨텍스트가 부족해 사이드바 정형 흐름이 우선. 작성 후엔 이게 유일한 다음 액션(에이전트 한정).
function IdleActions({
  steps,
  cli,
  onStartProcessing,
  onResumeProcessing,
  onComposeNotes,
  onRequestAi,
  onForceCompose,
  loginExpiredCli,
  onGoLogin,
}: IdleProps) {
  const agent = cliHasAgent(cli);
  if (steps.notes_written) {
    // 회의록 작성이 곧 마지막 단계. 복사(내보내기)는 회의록 탭 인라인 버튼이 담당하므로
    // 사이드바엔 두지 않는다. mlx는 추가 요청(/assist)이 없어 액션 없음 = 담백한 완료 상태.
    if (!agent) return null;
    return (
      <button className="btn btn-primary btn-large" onClick={onRequestAi}>
        AI에게 추가 요청
      </button>
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
  // 자동 작성 preflight가 로그인 만료를 감지하면(loginExpiredCli) 안내를 작성 버튼 **위에** 함께
  // 보인다(대체 X). persistent — 자리 비웠다 복귀해도 유지. 재로그인 후 세션 재진입 시 SessionScreen
  // 재검증이 안내를 걷고, 그 전에 "회의록 작성"을 눌러도 진행하며 안내가 clear된다(막다른 화면 없음).
  const label = steps.corrected ? "회의록 작성 (이어서)" : "회의록 작성";
  return (
    <>
      {loginExpiredCli && (
        <div className={styles.loginExpired}>
          <div className={styles.loginExpiredTitle}>⚠ 로그인이 만료됐어요</div>
          <p className={styles.loginExpiredDesc}>
            회의록 작성에 쓰는 AI 도구의 로그인이 만료됐어요. 아래 버튼을 누르면 <b>AI 도구 설정</b>
            이 열립니다. 거기서 다시 로그인한 뒤 돌아와 <b>회의록 작성</b>으로 이어가주세요.
          </p>
          <button className="btn btn-secondary" onClick={onGoLogin}>
            AI 도구 설정에서 로그인
          </button>
        </div>
      )}
      <button className="btn btn-primary btn-large" onClick={onComposeNotes}>
        {label}
      </button>
    </>
  );
}
