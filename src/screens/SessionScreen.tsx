import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import ProcessingPanel from "@/components/ProcessingPanel";
import WorkArea from "@/components/WorkArea";
import ErrorBoundary from "@/components/ErrorBoundary";
import SessionSidebarControls from "@/components/Sidebar/SessionSidebarControls";
import { useSidebarTarget } from "@/components/MainLayout";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import { useDialog } from "@/contexts/DialogContext";
import { DialogCheckbox } from "@/components/Dialog";
import useNavigationBlocker from "@/hooks/useNavigationBlocker";
import { Activity, Step, cliHasAgent } from "@/constants";
import { cancelMeetingWork } from "@/utils/headless";
import { loadMeetingMeta } from "@/utils/meetingMeta";
import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@/utils/notification";

// 회의 처리부터 검토까지 — Processing/Correcting/Composing/Idle.
// state 전환은 모두 SessionContext의 transition 메소드로. 화면은 confirm/navigate/toast만 organize.
export default function SessionScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const toast = useToast();
  const { confirm } = useDialog();
  const sidebarTarget = useSidebarTarget();

  const {
    meeting,
    sessionDir,
    steps,
    activity,
    activityRef,
    currentStepId,
    spawnRequest,
    refreshKey,
    enterProcessing,
    resetSessionToRecording,
    resetSessionToDiarized,
    completeProcessing,
    markNoSpeech,
    overrideNoSpeech,
    startComposing,
    restartCompose,
    markPipelineSubStep,
    markStepDone,
    notifyPtyExit,
    resetSession,
    cli,
    drawerOpen,
    toggleDrawer,
    completedActivity,
    isVerifying,
    focusSubtab,
    clearFocusSubtab,
    requestAi,
    terminalFocusKey,
    loginExpiredCli,
    clearLoginExpired,
    headlessActive,
  } = session;

  // attendees 참조 안정화 — 자식의 useEffect 의존성 배열이 매 렌더 무효화되는 것 방지.
  const attendees = useMemo<string[]>(() => meeting?.attendees ?? [], [meeting?.attendees]);

  // AI 다듬기·회의록 검증 토글 — 진행 패널의 단계 분모(2+다듬기+검증 = 2~4)와 사이드바
  // stepper의 다듬기 단계 노출을 결정. 컨텍스트 Meeting은 기존 회의 재열기 시 이 필드를
  // 싣지 않으므로 진실 원천(meeting.json)을 직접 읽는다. 부재(옛 세션)=둘 다 기본 ON.
  // 로컬 작성·재작성 선택이 ai_polish를 갱신하므로 작업 전환·완료 신호마다 다시 읽는다.
  const [verifyEnabled, setVerifyEnabled] = useState(true);
  const [polishEnabled, setPolishEnabled] = useState(true);
  useEffect(() => {
    if (!sessionDir) return;
    let stale = false;
    loadMeetingMeta(sessionDir)
      .then((meta) => {
        if (stale) return;
        setVerifyEnabled(meta?.notes_verification !== false);
        setPolishEnabled(meta?.ai_polish !== false);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [sessionDir, refreshKey, activity]);

  // 작업 중(Processing/Composing) router back/forward(POP) 차단.
  // Idle은 통과. 화면 내부 명시 navigate(handleAbort PUSH/REPLACE)는 통과.
  useNavigationBlocker({
    shouldBlock: () => activityRef.current !== Activity.Idle,
    confirm: {
      title: "진행 중인 작업이 있습니다",
      body: "현재 작업을 중단하고 이동하시겠습니까?",
      confirmLabel: "이동",
      danger: true,
    },
    cleanup: async () => {
      const currentActivity = activityRef.current;
      if (currentActivity === Activity.Processing) {
        await invoke<void>("cmd_cancel_pipeline").catch(() => {});
      } else if (
        currentActivity === Activity.Correcting ||
        currentActivity === Activity.Composing
      ) {
        // PTY·로컬(mlx)·headless(claude -p) 일괄 중단 — 없으면 각각 no-op.
        await cancelMeetingWork();
        // 의도적 kill은 pty:exit를 emit하지 않으므로(Rust 억제) activity를 직접 Idle 복귀 —
        // 화면 이탈 후 비-Idle이 잔존하면 다음 진입 transition 전까지 상태가 어긋난다.
        notifyPtyExit();
      }
    },
  });

  // ProcessingPanel 완료 → Composing 진입 + PTY spawn (Context가 처리)
  const handlePipelineComplete = useCallback(() => {
    void completeProcessing();
  }, [completeProcessing]);

  // 재로그인 후 세션 재진입 시 stale한 "로그인 만료" 안내를 걷는다 — 안내가 떠 있으면 현재 인증을
  // 재확인해 유효하면 clear(백그라운드·논블로킹). 만료로 설정 화면에 갔다 로그인하고 /session으로
  // 돌아오면 SessionScreen이 remount되며 이 검사가 돌아 안내가 자동으로 사라진다.
  useEffect(() => {
    if (!loginExpiredCli) return;
    void invoke<boolean>("cmd_is_cli_authed", { cli: loginExpiredCli })
      .then((authed) => {
        if (authed) clearLoginExpired();
      })
      .catch(() => {});
  }, [loginExpiredCli, clearLoginExpired]);

  // 전사 단계에서 무음("발화 없음") 감지 → diarize·회의록 건너뛰고 Idle로. 자리 비운
  // 사용자 대비 알림 전송 (정상 흐름의 /meeting 완료 알림 자리를 대체).
  const handleNoSpeech = useCallback(() => {
    markNoSpeech();
    sendNotification(
      "Junmit — 녹음된 발화 없음",
      "녹음에서 발화를 찾지 못해 회의록 작성을 건너뛰었습니다."
    );
  }, [markNoSpeech]);

  // escape hatch — "그래도 회의록 작성하기". 무음 판정 무효화 + 파이프라인 재개.
  const handleForceCompose = useCallback(() => {
    void overrideNoSpeech();
  }, [overrideNoSpeech]);

  const handlePipelineError = useCallback(
    (msg: string) => {
      toast.error(msg);
      sendNotification("Junmit — 처리 실패", msg);
      resetSession();
      navigate("/", { replace: true });
    },
    [toast, navigate, resetSession]
  );

  const handleProcessingStep = useCallback(
    (stepId: string) => markPipelineSubStep(stepId),
    [markPipelineSubStep]
  );

  // ProcessingPanel이 각 단계(transcribe/diarize) 완료 시 호출 → stepper ✓ 즉시 반영.
  const handleProcessingStepDone = useCallback(
    (stepId: string) => {
      if (stepId === "transcribe") markStepDone(Step.Transcribe);
      else if (stepId === "diarize") markStepDone(Step.Diarize);
    },
    [markStepDone]
  );

  // 사용자가 PTY에서 단독 Esc 키 누름 — Claude 응답 interrupt 의도 신호 (TerminalPanel onData에서 감지).
  // 즉시 activity Idle 복귀, confirm 없음. PTY는 그대로 살림 (사용자가 이어서 입력 가능).
  // notifyPtyExit이 Correcting/Composing에서만 Idle 전환하므로 다른 상태에선 자연스럽게 noop.
  // (mlx는 터미널 자체를 안 띄우므로 — 진행 패널로 대체 — 이 경로에 도달하지 않는다.)
  const handleEscape = useCallback(() => {
    notifyPtyExit();
  }, [notifyPtyExit]);

  // 사이드바 stepper는 기록 카드와 묻는 게 다르다 — 카드는 "이 회의에 다듬기가 있었나"(이력이라
  // 파일이 진실), 사이드바는 작업 중이면 "지금 도는 이 작업에 다듬기가 있나"다. 후자에선 현재
  // 백엔드가 그 작업의 주체 자체라 섞는 게 아니라 사실이고, 덕분에 파일 기록을 작업 완료까지
  // 미룰 수 있다(중단·실패가 잘못된 값을 남기지 않는다). 단 교정본이 이미 있으면(에이전트로 다듬은
  // 뒤 로컬로 재작성) 그 다듬기는 실재하므로 로컬 작업 중에도 계속 노출한다. Idle이면 이력=파일만.
  const polishInThisRun =
    polishEnabled && (cliHasAgent(cli) || steps.corrected || activity === Activity.Idle);

  // 재작성은 회의록 본문만 다시 만드는 일이라 회의록 층의 설정(검증)은 그 회의의 값을 그대로
  // 따른다. 전사본 층의 다듬기만, 그것도 교정본이 아직 없을 때만 "이번에 같이 만들까"를 묻는다 —
  // 이미 있으면 사용자가 손대는 자산이고 재작성이 그걸 재사용한다(utils/speakerCorrection.ts).
  //
  // steps.corrected만으로는 교정본 유무를 알 수 없다 — 다듬기 OFF 세션도 correct 신호를 보내고
  // phase_done도 방어적으로 올려서, 방금 작성한 세션과 다시 연 세션(Rust가 파일로 계산)의 판정이
  // 갈린다. ai_polish가 false면 교정본은 만들어지지 않으므로 둘을 함께 본다. (Rust 판정은 교정본과
  // 매핑을 둘 다 요구해 매핑만 실패한 세션은 "없음"으로 잡힌다 — 드물고 표시만 어긋난다.)
  const hasCorrectedTranscript = polishEnabled && steps.corrected;
  const canChoosePolish = cliHasAgent(cli) && !hasCorrectedTranscript;

  // 회의록 유형 변경 → confirm 후 Context가 backup·meta·pty·spawn 처리.
  // 반환값으로 NotesPreview의 낙관적 select 업데이트 롤백 여부 알림 (false = 롤백).
  const handleRetypeNotes = useCallback(
    async (newType: string): Promise<boolean> => {
      if (!sessionDir) return false;
      // confirm은 확인/취소만 돌려주므로 체크박스 값은 이 상자로 받는다.
      const polishChoice = { on: polishEnabled };
      const ok = await confirm({
        title: "회의록을 다시 작성합니다",
        body: (
          <>
            현재 회의록 본문은 <code>meeting-notes.bak.&#123;타임스탬프&#125;.md</code>로
            백업됩니다.
            <br />
            {canChoosePolish
              ? "전사본을 바탕으로 처음부터 다시 작성됩니다."
              : "교정된 전사·화자를 반영해 처음부터 다시 작성됩니다."}
            {canChoosePolish && (
              <DialogCheckbox
                label="AI 다듬기 포함"
                description="화자 자동 매칭 · 음성 인식 오류 교정"
                defaultChecked={polishEnabled}
                onChange={(v) => (polishChoice.on = v)}
              />
            )}
          </>
        ),
        confirmLabel: "다시 작성",
      });
      if (!ok) return false;
      // restartCompose가 activity를 바꾸기 전에 반영해야 한다 — 늦으면 그 사이 사이드바·진행
      // 패널이 이전 설정의 단계 수로 샌다.
      const prevPolish = polishEnabled;
      if (canChoosePolish) setPolishEnabled(polishChoice.on);
      try {
        await restartCompose(newType, canChoosePolish ? polishChoice.on : undefined);
        return true;
      } catch (e) {
        setPolishEnabled(prevPolish);
        toast.error(`회의록 재작성 준비 실패: ${e}`);
        return false;
      }
    },
    [sessionDir, confirm, toast, restartCompose, canChoosePolish, polishEnabled]
  );

  // 사이드바 액션 dispatch — 모두 Context transition 또는 단순 navigate/외부 명령
  const handleStartProcessing = useCallback(() => enterProcessing(), [enterProcessing]);
  const handleComposeNotes = useCallback(() => startComposing(), [startComposing]);
  // dev 전용: 녹음 끝난 시점으로 초기화 (처리 산출물 삭제 후 재처리 가능).
  const handleResetSession = useCallback(async () => {
    const ok = await confirm({
      title: "녹음 시점으로 초기화",
      body: "recording.wav만 남기고 전사·화자분리·회의록 등 처리 결과를 모두 삭제합니다. 되돌릴 수 없습니다.",
      confirmLabel: "초기화",
      danger: true,
    });
    if (!ok) return;
    await resetSessionToRecording();
  }, [confirm, resetSessionToRecording]);
  // dev 전용: 화자분리 시점으로 초기화 (회의록 관련 산출물만 삭제, 전사·화자분리 보존 → /meeting 재실행).
  const handleResetToDiarized = useCallback(async () => {
    const ok = await confirm({
      title: "화자분리 시점으로 초기화",
      body: "전사·화자분리 결과는 남기고 후보정·회의록 결과만 삭제합니다. /meeting을 처음부터 다시 돌릴 수 있습니다. 되돌릴 수 없습니다.",
      confirmLabel: "초기화",
      danger: true,
    });
    if (!ok) return;
    await resetSessionToDiarized();
  }, [confirm, resetSessionToDiarized]);

  // "AI에게 추가 요청" — 사이드바 보조 액션·panel 빈 상태 폼 공통 핸들러 (입력 선행).
  // Context가 drawer expand + 요청을 tier별로 전송(stdin/spawn 초기 프롬프트 병기) 처리.
  // 전송 후 토스트로 터미널 직접 입력을 안내 — 첫 요청이 PTY를 띄우고 나면 터미널 입력창이
  // 가장 빠른 경로다(폼 경유 전송에만 뜨므로 익힌 사용자에겐 자연히 안 보임). 커서도
  // 터미널로 이동하므로(terminalFocusKey) 문구가 "그대로 입력"을 안내한다.
  const handleRequestAi = useCallback(
    (request: string) => {
      void requestAi(request).then(() => {
        toast.info("이어지는 요청은 하단 입력창에 그대로 입력하면 돼요", {
          duration: 5000,
          position: "aboveTerminalInput",
        });
      });
    },
    [requestAi, toast]
  );

  const handleAbort = useCallback(async () => {
    const ok = await confirm({
      title: "진행 중인 작업을 중단하시겠습니까?",
      body: "현재 단계가 중단됩니다. 저장된 진행 상황은 '회의 기록'에서 재개할 수 있습니다.",
      confirmLabel: "중단",
      danger: true,
    });
    if (!ok) return;
    // PTY·로컬(mlx)·headless(claude -p) 일괄 중단 — 없으면 각각 no-op.
    await cancelMeetingWork();
    try {
      await invoke<void>("cmd_cancel_pipeline");
    } catch {}
    resetSession();
    navigate("/", { replace: true });
  }, [confirm, resetSession, navigate]);

  return (
    <>
      {/* Sidebar 콘텐츠 — Portal로 셸에 주입. 핸들러는 명시적 콜백 props. */}
      {sidebarTarget &&
        createPortal(
          <SessionSidebarControls
            activity={activity}
            steps={steps}
            currentStepId={currentStepId}
            isVerifying={isVerifying}
            cli={cli}
            polishEnabled={polishInThisRun}
            onAbort={handleAbort}
            onStartProcessing={handleStartProcessing}
            onResumeProcessing={handleStartProcessing}
            onComposeNotes={handleComposeNotes}
            onRequestAi={handleRequestAi}
            onForceCompose={handleForceCompose}
            onResetSession={handleResetSession}
            onResetToDiarized={handleResetToDiarized}
            loginExpiredCli={loginExpiredCli}
            onGoLogin={() => navigate("/settings/ai-tool")}
          />,
          sidebarTarget
        )}

      {/* 메인 영역 */}
      {activity === Activity.Processing && sessionDir && (
        <ErrorBoundary fallbackMessage="오디오 처리 중 오류가 발생했습니다.">
          <ProcessingPanel
            sessionDir={sessionDir}
            completedSteps={steps}
            onComplete={handlePipelineComplete}
            onError={handlePipelineError}
            onNoSpeech={handleNoSpeech}
            onStepChange={handleProcessingStep}
            onStepDone={handleProcessingStepDone}
          />
        </ErrorBoundary>
      )}
      {(activity === Activity.Correcting ||
        activity === Activity.Composing ||
        activity === Activity.Idle) && (
        <ErrorBoundary fallbackMessage="회의록·작업 패널에서 오류가 발생했습니다.">
          <WorkArea
            activity={activity}
            spawnRequest={spawnRequest}
            sessionDir={sessionDir}
            attendees={attendees}
            refreshKey={refreshKey}
            drawerOpen={drawerOpen}
            completedActivity={completedActivity}
            isVerifying={isVerifying}
            focusSubtab={focusSubtab}
            onUserTabChange={clearFocusSubtab}
            onToggleDrawer={toggleDrawer}
            notesWritten={steps.notes_written}
            assistAvailable={cliHasAgent(cli)}
            localBackend={!cliHasAgent(cli)}
            headlessBackend={headlessActive}
            verifyEnabled={verifyEnabled}
            polishEnabled={polishEnabled}
            noSpeech={steps.no_speech}
            onForceCompose={handleForceCompose}
            onRequestAi={handleRequestAi}
            terminalFocusKey={terminalFocusKey}
            onExit={notifyPtyExit}
            onEscape={handleEscape}
            onRetypeNotes={handleRetypeNotes}
          />
        </ErrorBoundary>
      )}
    </>
  );
}
