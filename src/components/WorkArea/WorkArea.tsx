import TerminalWorkspace from "../TerminalWorkspace";
import SessionViewer from "../SessionViewer";
import EmptyState from "./EmptyState";
import LocalProgressPanel from "./LocalProgressPanel";
import AgentProgressPanel from "./AgentProgressPanel";
import { Activity } from "@/constants";
import type { SpawnRequest } from "@/types";
import styles from "./WorkArea.module.css";

// Activity별 panel 헤더 라벨 — "검은 화면 영문 TUI"를 "AI 작업 진행 표시기"로 재맥락화.
// "Claude" 같은 LLM 제품명 노출은 미래 다른 모델 확장 + 일반 사용자 친화 양쪽 다 부적합 → "AI"로 통일.
// AI 다듬기 OFF의 Correcting은 다듬기가 아니라 회의 정보 확인 구간이라 "다듬는 중"이 거짓.
function panelLabelFor(activity: Activity, polishEnabled: boolean): string {
  switch (activity) {
    case Activity.Correcting:
      return polishEnabled
        ? "AI가 회의 내용을 다듬는 중입니다"
        : "AI가 회의 정보를 확인하는 중입니다";
    case Activity.Composing:
      return "AI가 회의록을 작성하는 중입니다";
    default:
      return "AI 작업";
  }
}

// phase_done OSC 신호로 정상 완료한 작업의 띠 라벨. SessionContext.completedActivity에 들어오는 값.
function doneLabelFor(completed: Activity): string {
  switch (completed) {
    case Activity.Correcting:
    case Activity.Composing:
      return "✓ 회의록 작성 완료";
    default:
      return "✓ 완료";
  }
}

interface WorkAreaProps {
  activity: Activity;
  spawnRequest: SpawnRequest | null;
  sessionDir: string | null;
  attendees?: string[];
  refreshKey?: number;
  // drawer 상태는 SessionContext가 진실 원천 — 자동 expand 정책이 다른 transition과 함께 묶임.
  drawerOpen: boolean;
  // phase_done OSC로 정상 완료한 직전 Activity. null이면 일반 라벨. SessionContext 관리.
  completedActivity: Activity | null;
  // 회의록 자기검증 진행 중 — 공개(phase_done) 후에도 완료 띠 대신 "검증 중"을 표시해
  // 아직 작업이 이어지고 있음을 알린다 (verify 신호로 해제 → 그때 완료 띠).
  isVerifying?: boolean;
  // activity 기반 라벨 대신 표시할 임시 라벨 (도우미 프로세스 진행 중 등).
  labelOverride?: string | null;
  // 단계 완료 시 SessionViewer가 자동 이동할 sub-tab id. 사용자 탭 클릭 시 onUserTabChange로 clear.
  focusSubtab: string | null;
  onUserTabChange: () => void;
  onToggleDrawer: () => void;
  // panel 빈 상태 UI 분기 + 진입점 버튼. 사이드바의 "AI에게 추가 요청"과 동일 핸들러.
  notesWritten: boolean;
  // 대화형 추가 요청(/assist) 가능 여부 — mlx(로컬 LLM)는 에이전트가 없어 false.
  assistAvailable?: boolean;
  // 로컬 AI 백엔드 — 터미널 대신 진행 패널(local:output 스트림)을 drawer에 표시.
  localBackend?: boolean;
  // headless(claude -p) 실행 중/직후 — 터미널 대신 구조화 진행 패널(headless:event 스트림) 표시.
  // localBackend와 배타적이진 않지만(둘 다 진행 패널) headless가 우선 — SessionContext가 관리.
  headlessBackend?: boolean;
  // 회의록 검증 토글(meeting.json notes_verification, 기본 ON) — 진행 패널의 단계 분모 결정.
  verifyEnabled?: boolean;
  // AI 다듬기 토글(meeting.json ai_polish, 기본 ON) — 진행 패널의 다듬기 단계 유무 결정.
  // OFF면 Correcting 동안에도 준비 단계로 표시(다듬기 단계 자체가 없음).
  polishEnabled?: boolean;
  // 무음("발화 없음")으로 diarize·회의록을 건너뛴 세션 — SessionViewer가 전용 빈 상태 표시.
  noSpeech?: boolean;
  // escape hatch — "그래도 회의록 작성하기". 무음 빈 상태 버튼이 호출.
  onForceCompose?: () => void;
  // 추가 요청 전송 (입력 선행 — EmptyState 폼이 요청 텍스트를 먼저 받아 전달).
  onRequestAi: (request: string) => void;
  // 추가 요청 전송마다 bump — 터미널 focus 트리거 (TerminalWorkspace로 전달).
  terminalFocusKey?: number;
  onExit: () => void;
  // 사용자가 PTY에서 단독 Esc 누름 — Claude 응답 interrupt 의도. SessionScreen이 activity Idle 복귀 처리.
  onEscape?: () => void;
  onRetypeNotes?: (newType: string) => Promise<boolean>;
}

// 회의록 화면의 작업 영역 — 공통 셸(TerminalWorkspace)에 좌측 SessionViewer + 세션 맥락 라벨/빈 상태를 주입.
export default function WorkArea({
  activity,
  spawnRequest,
  sessionDir,
  attendees = [],
  refreshKey = 0,
  drawerOpen,
  completedActivity,
  isVerifying = false,
  labelOverride = null,
  focusSubtab,
  onUserTabChange,
  onToggleDrawer,
  notesWritten,
  assistAvailable = true,
  localBackend = false,
  headlessBackend = false,
  verifyEnabled = true,
  polishEnabled = true,
  noSpeech = false,
  onForceCompose,
  onRequestAi,
  terminalFocusKey = 0,
  onExit,
  onEscape,
  onRetypeNotes,
}: WorkAreaProps) {
  // headless 작업 중엔 헤더를 총괄 문구로 고정 — 구체 단계·경과·안내는 패널 상태 라인이
  // **유일한 동적 표시**로 전담한다(AgentProgressPanel). 헤더에 시간·단계를 얹으면 같은 정보가
  // 두 곳에서 동시에 움직여 산만하다. 완료 후엔 null로 비켜나 완료 띠(✓)가 동작.
  const headlessWorking =
    headlessBackend &&
    (activity === Activity.Correcting || activity === Activity.Composing || isVerifying);
  const effectiveOverride =
    labelOverride ?? (headlessWorking ? "AI가 회의록을 만드는 중입니다" : null);
  // 검증 중에는 완료 띠보다 우선 — phase_done으로 completedActivity가 이미 set돼 있어도
  // 아직 자기검증이 돌고 있으므로 "완료"로 보이면 안 된다 (검증 종료 시 완료 띠로 전환).
  const headerLabel =
    effectiveOverride ??
    (isVerifying
      ? "AI가 회의록을 검증하는 중입니다"
      : completedActivity !== null
        ? doneLabelFor(completedActivity)
        : panelLabelFor(activity, polishEnabled));
  const headerDone = effectiveOverride == null && !isVerifying && completedActivity !== null;

  const emptyState = (
    <EmptyState
      notesWritten={notesWritten}
      assistAvailable={assistAvailable}
      onRequestAi={onRequestAi}
    />
  );

  return (
    <TerminalWorkspace
      spawnRequest={spawnRequest}
      onExit={onExit}
      onEscape={onEscape}
      drawerOpen={drawerOpen}
      focusKey={terminalFocusKey}
      onToggleDrawer={onToggleDrawer}
      panelLabel={headerLabel}
      panelDone={headerDone}
      emptyState={emptyState}
      panelContent={
        // headless(claude -p)·로컬 AI는 상호작용할 터미널이 없다 — 진행 패널로 대체.
        // headless가 우선 — headlessActive는 PTY spawn 시점마다 해제되므로 충돌 없음.
        headlessBackend ? (
          <AgentProgressPanel
            activity={activity}
            verifying={isVerifying}
            verifyEnabled={verifyEnabled}
            polishEnabled={polishEnabled}
            emptyState={emptyState}
          />
        ) : localBackend ? (
          <LocalProgressPanel activity={activity} emptyState={emptyState} />
        ) : undefined
      }
    >
      {sessionDir ? (
        <SessionViewer
          key={refreshKey}
          sessionPath={sessionDir}
          attendees={attendees}
          focusSubtab={focusSubtab}
          onUserTabChange={onUserTabChange}
          onRetypeNotes={onRetypeNotes}
          noSpeech={noSpeech}
          onForceCompose={onForceCompose}
        />
      ) : (
        <div className={styles.viewerAreaEmpty}>회의를 선택해주세요</div>
      )}
    </TerminalWorkspace>
  );
}
