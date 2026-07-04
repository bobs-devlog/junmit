import TerminalWorkspace from "../TerminalWorkspace";
import SessionViewer from "../SessionViewer";
import EmptyState from "./EmptyState";
import LocalProgressPanel from "./LocalProgressPanel";
import { Activity } from "@/constants";
import type { SpawnRequest } from "@/types";
import styles from "./WorkArea.module.css";

// Activity별 panel 헤더 라벨 — "검은 화면 영문 TUI"를 "AI 작업 진행 표시기"로 재맥락화.
// "Claude" 같은 LLM 제품명 노출은 미래 다른 모델 확장 + 일반 사용자 친화 양쪽 다 부적합 → "AI"로 통일.
function panelLabelFor(activity: Activity): string {
  switch (activity) {
    case Activity.Correcting:
      return "AI가 회의 내용을 다듬는 중입니다";
    case Activity.Composing:
      return "AI가 회의록을 작성하는 중입니다";
    case Activity.Publishing:
      return "AI가 Confluence에 등록하는 중입니다";
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
    case Activity.Publishing:
      return "✓ Confluence 등록 완료";
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
  // activity 기반 라벨 대신 표시할 임시 라벨 (예: 발행 전 Atlassian 로그인 도우미 진행 중).
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
  // 무음("발화 없음")으로 diarize·회의록을 건너뛴 세션 — SessionViewer가 전용 빈 상태 표시.
  noSpeech?: boolean;
  // escape hatch — "그래도 회의록 작성하기". 무음 빈 상태 버튼이 호출.
  onForceCompose?: () => void;
  onRequestAi: () => void;
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
  labelOverride = null,
  focusSubtab,
  onUserTabChange,
  onToggleDrawer,
  notesWritten,
  assistAvailable = true,
  localBackend = false,
  noSpeech = false,
  onForceCompose,
  onRequestAi,
  onExit,
  onEscape,
  onRetypeNotes,
}: WorkAreaProps) {
  const headerLabel =
    labelOverride ??
    (completedActivity !== null ? doneLabelFor(completedActivity) : panelLabelFor(activity));
  const headerDone = labelOverride == null && completedActivity !== null;

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
      onToggleDrawer={onToggleDrawer}
      panelLabel={headerLabel}
      panelDone={headerDone}
      emptyState={emptyState}
      panelContent={
        // 로컬 AI는 상호작용할 터미널이 없다 — 진행 라인 패널로 대체 (전사·화자분리와 같은 결).
        localBackend ? (
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
