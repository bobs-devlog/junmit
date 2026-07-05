import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import ProcessingPanel from "@/components/ProcessingPanel";
import WorkArea from "@/components/WorkArea";
import PublishModal from "@/components/PublishModal";
import ErrorBoundary from "@/components/ErrorBoundary";
import SessionSidebarControls from "@/components/Sidebar/SessionSidebarControls";
import { useSidebarTarget } from "@/components/MainLayout";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import { useDialog } from "@/contexts/DialogContext";
import useNavigationBlocker from "@/hooks/useNavigationBlocker";
import useAtlassianLogin from "@/hooks/useAtlassianLogin";
import { Activity, Step, cliHasAgent } from "@/constants";
import type { ConfluencePublishMode } from "@/types";
import { loadPublishConfig, updatePublishConfig, defaultPublishConfig } from "@/utils/publishMeta";
import { killPty, sendSlashCommand } from "@/utils/pty";
import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@/utils/notification";

// 회의 처리부터 검토·등록까지 — Processing/Correcting/Composing/Publishing/Idle.
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
    enterPublishing,
    markPublished,
    restartCompose,
    markPipelineSubStep,
    markStepDone,
    notifyPtyExit,
    resetSession,
    isPtyAlive,
    spawnPty,
    spawnShell,
    cli,
    appDir,
    drawerOpen,
    openDrawer,
    toggleDrawer,
    completedActivity,
    focusSubtab,
    clearFocusSubtab,
    requestAi,
  } = session;

  // attendees 참조 안정화 — 자식의 useEffect 의존성 배열이 매 렌더 무효화되는 것 방지.
  const attendees = useMemo<string[]>(() => meeting?.attendees ?? [], [meeting?.attendees]);

  // 사이드바 Primary "Confluence 등록" 클릭 시 PublishModal open. 발행 후·취소 시 close.
  const [publishModalOpen, setPublishModalOpen] = useState(false);

  // publish.json.confluence.mode — 사이드바 Primary 분기에 사용 (create만 "Confluence 열기" 노출).
  // sessionDir·refreshKey 변경 + modal close 시점에 reload.
  const [publishMode, setPublishMode] = useState<ConfluencePublishMode>(
    defaultPublishConfig().confluence.mode
  );

  const reloadPublishMode = useCallback(async () => {
    if (!sessionDir) {
      setPublishMode(defaultPublishConfig().confluence.mode);
      return;
    }
    try {
      const cfg = await loadPublishConfig(sessionDir);
      setPublishMode(cfg.confluence.mode);
    } catch {
      setPublishMode(defaultPublishConfig().confluence.mode);
    }
  }, [sessionDir]);

  // 외부 트리거(sessionDir/refreshKey)에 따라 publishMode 동기화 — setState in effect는 의도된 동작.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    reloadPublishMode();
  }, [sessionDir, refreshKey, reloadPublishMode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 작업 중(Processing/Composing/Publishing) router back/forward(POP) 차단.
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
        currentActivity === Activity.Composing ||
        currentActivity === Activity.Publishing
      ) {
        await killPty();
        // 로컬 AI 회의록 서브프로세스 — 없으면 no-op.
        await invoke<void>("cmd_cancel_local_meeting").catch(() => {});
        // 의도적 kill은 pty:exit를 emit하지 않으므로(Rust 억제) activity를 직접 Idle 복귀 —
        // 화면 이탈 후 비-Idle이 잔존하면 다음 진입 transition 전까지 상태가 어긋난다.
        notifyPtyExit();
      }
    },
  });

  // ProcessingPanel 완료 → Composing 진입 + PTY spawn (Context가 처리)
  const handlePipelineComplete = useCallback(() => {
    completeProcessing();
  }, [completeProcessing]);

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

  // create 모드 발행 트리거 — Tier 1 (살아있는 PTY stdin write) 우선, 실패 시 Tier 2 (새 spawn).
  // sessionDir은 APP_SESSION_DIR env로 전달 (claude 슬래시 파서 quote 처리 한계 회피).
  const triggerPublishSkill = useCallback(async () => {
    enterPublishing();
    try {
      if (await isPtyAlive()) {
        try {
          await sendSlashCommand("/publish", cli);
        } catch {
          // Tier 1 실패 (PTY가 죽었거나 stdin write 실패) → Tier 2 새 PTY spawn fallback
          spawnPty(`/publish`);
        }
      } else {
        spawnPty(`/publish`);
      }
    } catch (e) {
      // 트리거 자체 실패 — Activity 복원해 사용자가 다음 작업 가능하도록.
      toast.error(`발행 트리거 실패: ${e}`);
      notifyPtyExit();
    }
  }, [enterPublishing, isPtyAlive, cli, spawnPty, toast, notifyPtyExit]);

  // Atlassian 로그인 오케스트레이션 — 별도 훅으로 분리(SRP). 인증 확인 후 발행 재개는
  // onAuthed에 triggerPublishSkill을 주입해 단방향 의존(화면 → 훅)으로 묶는다.
  // 반환값은 구조분해 — 안정 콜백을 deps에 직접 써 참조 안정성 유지(반환 객체는 매 렌더 새 생성).
  const {
    loginActive: atlassianLoginActive,
    beginLogin: beginAtlassianLogin,
    handlePtyExit,
  } = useAtlassianLogin({
    cli,
    appDir,
    spawnShell,
    openDrawer,
    notifyPtyExit,
    onAuthed: triggerPublishSkill,
    toast,
  });

  // 사용자가 PTY에서 단독 Esc 키 누름 — Claude 응답 interrupt 의도 신호 (TerminalPanel onData에서 감지).
  // 즉시 activity Idle 복귀, confirm 없음. PTY는 그대로 살림 (사용자가 이어서 입력 가능).
  // notifyPtyExit이 Correcting/Composing/Publishing에서만 Idle 전환하므로 다른 상태에선 자연스럽게 noop.
  // (mlx는 터미널 자체를 안 띄우므로 — 진행 패널로 대체 — 이 경로에 도달하지 않는다.)
  const handleEscape = useCallback(() => {
    notifyPtyExit();
  }, [notifyPtyExit]);

  // 회의록 유형 변경 → confirm 후 Context가 backup·meta·pty·spawn 처리.
  // 반환값으로 NotesPreview의 낙관적 select 업데이트 롤백 여부 알림 (false = 롤백).
  const handleRetypeNotes = useCallback(
    async (newType: string): Promise<boolean> => {
      if (!sessionDir) return false;
      const ok = await confirm({
        title: "회의록을 다시 작성합니다",
        body: (
          <>
            현재 회의록 본문은 <code>meeting-notes.bak.&#123;타임스탬프&#125;.md</code>로
            백업됩니다.
            <br />
            교정된 전사·화자를 반영해 처음부터 다시 작성됩니다. 진행할까요?
          </>
        ),
        confirmLabel: "다시 작성",
      });
      if (!ok) return false;
      try {
        await restartCompose(newType);
        return true;
      } catch (e) {
        toast.error(`회의록 재작성 준비 실패: ${e}`);
        return false;
      }
    },
    [sessionDir, confirm, toast, restartCompose]
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
      body: "전사·화자분리 결과는 남기고 후보정·회의록·발행 결과만 삭제합니다. /meeting을 처음부터 다시 돌릴 수 있습니다. 되돌릴 수 없습니다.",
      confirmLabel: "초기화",
      danger: true,
    });
    if (!ok) return;
    await resetSessionToDiarized();
  }, [confirm, resetSessionToDiarized]);
  // 사이드바 Primary "Confluence 등록" — PublishModal open. 실제 발행은 modal 안 "확인" 버튼이
  // 트리거하며, 그 시점에 atlassian MCP 등록(lazy) + 인증 게이트가 돈다(prefetch 불가 — 등록이
  // config를 바꾸므로).
  const handlePublish = useCallback(() => {
    setPublishModalOpen(true);
  }, []);

  // "AI에게 추가 요청" — 사이드바 보조 액션·panel 빈 상태 버튼 공통 핸들러.
  // Context가 drawer expand + (PTY 죽었으면) 자유 대화 spawn 처리.
  const handleRequestAi = useCallback(() => {
    void requestAi();
  }, [requestAi]);

  const handleAbort = useCallback(async () => {
    const ok = await confirm({
      title: "진행 중인 작업을 중단하시겠습니까?",
      body: "현재 단계가 중단됩니다. 저장된 진행 상황은 '회의 기록'에서 재개할 수 있습니다.",
      confirmLabel: "중단",
      danger: true,
    });
    if (!ok) return;
    await killPty();
    try {
      await invoke<void>("cmd_cancel_pipeline");
    } catch {}
    // 로컬 AI 회의록 서브프로세스 — 없으면 no-op.
    try {
      await invoke<void>("cmd_cancel_local_meeting");
    } catch {}
    resetSession();
    navigate("/", { replace: true });
  }, [confirm, resetSession, navigate]);

  // 사이드바 Primary "Confluence 열기" — create 모드 + published 상태에서만 노출되므로
  // create 가정. pageUrl이 비어있으면 발행 실패 케이스로 보고 modal로 재시도 유도.
  // append/skip 모드는 사이드바에서 이 버튼 자체를 노출하지 않음 (시스템이 외부 페이지 URL 모름).
  const handleOpenConfluence = useCallback(async () => {
    if (!sessionDir) return;
    try {
      const cfg = await loadPublishConfig(sessionDir);
      const url = cfg.confluence.pageUrl.trim();
      if (url) {
        await invoke("cmd_open_path", { path: url });
      } else if (!cliHasAgent(cli)) {
        // 발행 재시도는 에이전트 전용(/publish 스킬) — 로컬 AI에선 모달로 유도하면
        // 미설치 CLI를 spawn하는 막다른 길이 된다 (published인데 pageUrl이 빈 실패 잔재 케이스).
        toast.info("발행 기록이 불완전해요. 발행 재시도는 Claude/Codex에서만 가능합니다.");
      } else {
        // handlePublish 경유 — 모달 open과 인증 prefetch 갱신이 항상 함께 가도록 (직접 open 금지).
        handlePublish();
      }
    } catch (e) {
      toast.error(`Confluence URL 열기 실패: ${e}`);
    }
  }, [sessionDir, toast, handlePublish, cli]);

  // PublishModal "확인" 클릭 — mode별 본격 분기.
  // - create: Tier 1 (살아있는 PTY stdin write) 또는 Tier 2 (새 PTY spawn) → publish 스킬이 publish.json·phase_done 처리
  // - append: Frontend가 클립보드 복사 + 알림 + published=true 마킹 (publish 스킬 미호출)
  // - skip: Frontend가 confirm + published=true 마킹
  // modal 닫기는 발행 trigger 직후 (PTY 진행은 비동기로 백그라운드 진행 + Activity.Publishing 노출).
  const handleConfluencePublish = useCallback(
    async (mode: ConfluencePublishMode, displayMd: string) => {
      if (!sessionDir) return;
      if (activityRef.current !== Activity.Idle) {
        toast.info("작업이 진행 중입니다. 완료 후 다시 시도해주세요.");
        return;
      }

      if (mode === "skip") {
        const ok = await confirm({
          title: "Confluence 등록 없이 완료할까요?",
          body: "회의록은 [회의록] 탭에서 언제든 확인할 수 있습니다.",
          confirmLabel: "완료",
        });
        if (!ok) return;
        try {
          const cfg = await loadPublishConfig(sessionDir);
          await updatePublishConfig(sessionDir, {
            confluence: { ...cfg.confluence, published: true },
          });
          markPublished();
          setPublishModalOpen(false);
          reloadPublishMode();
          toast.success("발행을 건너뛰고 완료했습니다.");
        } catch (e) {
          toast.error(`발행 마킹 실패: ${e}`);
        }
        return;
      }

      if (mode === "append") {
        try {
          await navigator.clipboard.writeText(displayMd);
          await sendNotification(
            "Junmit — 회의록 복사 완료",
            "Confluence 페이지에 직접 붙여넣어주세요."
          );
          const cfg = await loadPublishConfig(sessionDir);
          await updatePublishConfig(sessionDir, {
            confluence: { ...cfg.confluence, published: true },
          });
          markPublished();
          setPublishModalOpen(false);
          reloadPublishMode();
          toast.success("회의록이 클립보드에 복사되었습니다.");
        } catch (e) {
          toast.error(`회의록 복사 실패: ${e}`);
        }
        return;
      }

      // create — 발행 직전 Atlassian MCP 등록(lazy) + 인증 게이트(JIT). 이 시점 전까지는 MCP가
      // CLI config에 선언돼 있지 않아 비-Confluence 사용자가 기동 워닝을 보지 않는다. 등록은 동의
      // 맥락이 자명한 발행 시점에 1회 한다. 판정 자체가 실패하면 통과 — publish 스킬이 실패를
      // 안내하는 쪽이 게이트 오작동으로 발행이 막히는 것보다 낫다.
      {
        // MCP 등록(플래그 set + config 반영) 후 fresh 조회 — 방금 config를 바꿨으므로 등록 전
        // 결과를 쓰면 안 된다(미등록 상태는 "통과"로 잡혀 로그인을 건너뛰게 됨).
        // antigravity는 격리 환경이 없어 등록이 사용자 전역 agy 설정에 남는다 — 신규 등록일
        // 때만 1회 고지해, 사용자가 나중에 개인 agy에서 이 서버를 발견해도 출처를 알게 한다
        // (claude/codex는 junmit 소유 config라 false 고정, 고지 없음).
        const newlyRegistered = await invoke<boolean>("cmd_enable_atlassian_mcp", { cli }).catch(
          () => false
        );
        if (newlyRegistered) {
          toast.info("Antigravity CLI 설정에 Atlassian 연결을 등록했습니다.");
        }
        // antigravity는 MCP 인증 조회 수단이 없어(agy에 mcp 서브커맨드 부재) 항상 통과 —
        // 아래 로그인 다이얼로그에 도달하지 않으며, 미인증은 publish 스킬이 실행 중 안내한다.
        // agy가 판정 수단을 제공하면 여기 codex/claude처럼 전용 안내 분기를 추가할 것.
        const authed = await invoke<boolean>("cmd_cli_atlassian_authed", { cli }).catch(() => true);
        if (!authed) {
          const ok = await confirm({
            title: "Atlassian 로그인이 필요합니다",
            body:
              cli === "codex" ? (
                <>
                  Confluence 등록에는 Atlassian 로그인이 1회 필요합니다.
                  <br />
                  [로그인]을 누르면 브라우저에서 인증이 진행되고, 완료되면 발행이 이어서 진행됩니다.
                </>
              ) : (
                <>
                  Confluence 등록에는 Atlassian 로그인이 1회 필요합니다.
                  <br />
                  [로그인]을 누르면 작업 패널 터미널이 열립니다. 터미널에서 atlassian을 선택해
                  브라우저 인증을 마치면 발행이 자동으로 이어집니다.
                </>
              ),
            confirmLabel: "로그인",
          });
          if (!ok) return;
          setPublishModalOpen(false);
          reloadPublishMode();
          beginAtlassianLogin();
          return;
        }
      }

      setPublishModalOpen(false);
      reloadPublishMode();
      await triggerPublishSkill();
    },
    [
      sessionDir,
      activityRef,
      confirm,
      toast,
      markPublished,
      cli,
      beginAtlassianLogin,
      reloadPublishMode,
      triggerPublishSkill,
    ]
  );

  return (
    <>
      {/* Sidebar 콘텐츠 — Portal로 셸에 주입. 핸들러는 명시적 콜백 props. */}
      {sidebarTarget &&
        createPortal(
          <SessionSidebarControls
            activity={activity}
            steps={steps}
            currentStepId={currentStepId}
            cli={cli}
            publishMode={publishMode}
            onAbort={handleAbort}
            onStartProcessing={handleStartProcessing}
            onResumeProcessing={handleStartProcessing}
            onComposeNotes={handleComposeNotes}
            onPublish={handlePublish}
            onOpenConfluence={handleOpenConfluence}
            onRequestAi={handleRequestAi}
            onForceCompose={handleForceCompose}
            onResetSession={handleResetSession}
            onResetToDiarized={handleResetToDiarized}
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
        activity === Activity.Publishing ||
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
            labelOverride={atlassianLoginActive ? "Atlassian 로그인을 진행하는 중입니다" : null}
            focusSubtab={focusSubtab}
            onUserTabChange={clearFocusSubtab}
            onToggleDrawer={toggleDrawer}
            notesWritten={steps.notes_written}
            assistAvailable={cliHasAgent(cli)}
            localBackend={!cliHasAgent(cli)}
            noSpeech={steps.no_speech}
            onForceCompose={handleForceCompose}
            onRequestAi={handleRequestAi}
            onExit={handlePtyExit}
            onEscape={handleEscape}
            onRetypeNotes={handleRetypeNotes}
          />
        </ErrorBoundary>
      )}

      {sessionDir && (
        <PublishModal
          open={publishModalOpen}
          sessionPath={sessionDir}
          onDismiss={() => {
            setPublishModalOpen(false);
            // modal 안에서 mode 변경했을 수 있으므로 사이드바 분기 동기화.
            reloadPublishMode();
          }}
          onConfirm={handleConfluencePublish}
        />
      )}
    </>
  );
}
