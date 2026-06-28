import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import RecordingSidebarControls from "@/components/Sidebar/RecordingSidebarControls";
import RecordingNotes from "@/components/RecordingNotes";
import Spinner from "@/components/Spinner";
import { useSidebarTarget } from "@/components/MainLayout";
import { useSession } from "@/contexts/SessionContext";
import { useRecorderContext } from "@/contexts/RecorderContext";
import { useToast } from "@/contexts/ToastContext";
import { useDialog } from "@/contexts/DialogContext";
import useNavigationBlocker from "@/hooks/useNavigationBlocker";
import useRecordingNotes from "@/hooks/useRecordingNotes";
import useRecordingReminder from "@/hooks/useRecordingReminder";
import useRecordingTray from "@/hooks/useRecordingTray";
import { DEFAULT_DURATION_MIN, Activity, MIC_PRIVACY_SETTINGS_URL } from "@/constants";
import { saveRecording } from "@/utils/saveRecording";
import { MIC_PERMISSION_DENIED } from "@/hooks/useRecorder";
import { hideReminderWindow } from "@/utils/reminderWindow";
import { invoke } from "@tauri-apps/api/core";
import styles from "@/App.module.css";

// 참석자 미정 시 넘기는 안정 빈 배열 — 매 렌더 새 `[]`를 만들면 memo(RecordingNotes)가 무력화돼
// 레벨 미터 60Hz 리렌더가 메모 패널까지 번진다. 모듈 상수로 참조를 고정한다.
const NO_ATTENDEES: string[] = [];

// 녹음·저장 전용 화면. 마운트 시 recorder.start, 중지·중단은 사이드바 컨트롤.
// 종료 시각 리마인더(useRecordingReminder)·메뉴바 트레이(useRecordingTray)·메모(useRecordingNotes)는
// 각 훅이 담당하고, 이 화면은 녹음 제어 + 조립(composition root)만 맡는다.
// state 전환은 모두 SessionContext의 transition 메소드로.
export default function RecordingScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const recorder = useRecorderContext();
  const toast = useToast();
  const { confirm } = useDialog();
  const sidebarTarget = useSidebarTarget();

  const {
    meeting,
    activity,
    activityRef,
    markSavingStarted,
    finishRecording,
    setCancelled,
    isCancelled,
    resetSession,
  } = session;

  const durationMin = meeting?.duration || DEFAULT_DURATION_MIN;

  // 녹음 중 메모(화자 힌트·자유 메모) — 종료 시 notesRef를 notes.json으로 flush.
  const { notes, notesRef, addSpeaker, addText, editText, removeNote } = useRecordingNotes(
    recorder.elapsed
  );

  // Recording/Saving 중 router back/forward(POP) 차단 — confirm 후 녹음 정리.
  // 화면 내부 명시 navigate(handleAbort/handleStop 등 PUSH/REPLACE)는 통과.
  useNavigationBlocker({
    shouldBlock: () =>
      activityRef.current === Activity.Recording || activityRef.current === Activity.Saving,
    confirm: {
      title: "녹음을 중단하시겠습니까?",
      body: "현재까지 녹음된 내용은 저장되지 않습니다.",
      confirmLabel: "중단",
      danger: true,
    },
    cleanup: async () => {
      setCancelled(true);
      recorder.abort();
      try {
        await recorder.stop();
      } catch {}
    },
  });

  // 마운트 시 recorder.start. activity=Recording은 HomeScreen이 navigate와 함께 set.
  // 실패(권한 거부 등)는 confirm 후 home으로 navigate.
  // StrictMode 이중 마운트 방어용 ref.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        await recorder.start();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (cancelled) return;
        if (err.name === MIC_PERMISSION_DENIED) {
          const ok = await confirm({
            title: "마이크 권한이 필요합니다",
            body: (
              <>
                Junmit가 회의를 녹음하려면 마이크 접근 권한이 필요합니다.
                <br />
                시스템 설정에서 권한을 허용한 뒤 앱을 재시작해주세요.
              </>
            ),
            confirmLabel: "시스템 설정 열기",
            cancelLabel: "닫기",
          });
          if (ok) {
            try {
              await invoke<void>("cmd_open_path", { path: MIC_PRIVACY_SETTINGS_URL });
            } catch (openErr) {
              toast.error(`설정 열기 실패: ${openErr}`);
            }
          }
        } else {
          toast.error(`마이크 접근 실패: ${err.message}`);
        }
        resetSession();
        navigate("/", { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // 한 번만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 녹음 중지 → saving → 저장 성공 시 /session으로 navigate (Processing 활성)
  const handleStop = useCallback(async () => {
    // reminder가 떠있는 상태에서 사이드바로 종료할 때 잠시 잔존하는 걸 방지.
    void hideReminderWindow();
    markSavingStarted();
    const captured = await recorder.stop();
    if (!captured || isCancelled()) {
      if (!isCancelled()) {
        resetSession();
        navigate("/", { replace: true });
      }
      return;
    }
    try {
      const dir = await saveRecording(meeting, isCancelled, notesRef.current);
      if (!dir || isCancelled()) return;
      finishRecording(dir);
      navigate("/session", { replace: true });
    } catch (e) {
      toast.error(`저장 실패: ${e}`);
      resetSession();
      navigate("/", { replace: true });
    }
  }, [
    recorder,
    meeting,
    toast,
    navigate,
    markSavingStarted,
    finishRecording,
    resetSession,
    isCancelled,
    notesRef,
  ]);

  // 중단 — 녹음 폐기, Home으로
  const handleAbort = useCallback(async () => {
    // reminder가 떠있는 상태에서 사이드바로 중단할 때 잠시 잔존하는 걸 방지.
    void hideReminderWindow();
    const ok = await confirm({
      title: "녹음을 중단하시겠습니까?",
      body: "현재까지 녹음된 내용은 저장되지 않습니다.",
      confirmLabel: "중단",
      danger: true,
    });
    if (!ok) return;
    setCancelled(true);
    recorder.abort();
    try {
      await recorder.stop();
    } catch {}
    resetSession();
    navigate("/", { replace: true });
  }, [recorder, confirm, setCancelled, resetSession, navigate]);

  // 종료 시각 리마인더 — listener의 "종료"는 handleStop을 onStop으로 주입(단방향). nextTriggerSec은
  // 사이드바 타이머 표시 기준.
  const { nextTriggerSec } = useRecordingReminder({
    activity,
    isRecording: recorder.isRecording,
    elapsed: recorder.elapsed,
    durationMin,
    isCalendar: meeting?.source === "calendar",
    onStop: handleStop,
  });

  // 메뉴바 트레이 — 녹음 중에만 표시.
  useRecordingTray(activity, recorder.elapsed);

  return (
    <>
      {sidebarTarget &&
        createPortal(
          <RecordingSidebarControls
            activity={activity}
            elapsed={recorder.elapsed}
            level={recorder.level}
            targetSec={nextTriggerSec}
            onStop={handleStop}
            onAbort={handleAbort}
          />,
          sidebarTarget
        )}

      {/* 메인 영역 — 녹음 중엔 메모 패널, Saving은 안내 표시 */}
      {activity === Activity.Recording && (
        <RecordingNotes
          attendees={meeting?.attendees ?? NO_ATTENDEES}
          notes={notes}
          onAddSpeaker={addSpeaker}
          onAddText={addText}
          onEditText={editText}
          onRemove={removeNote}
        />
      )}

      {activity === Activity.Saving && (
        <div className={styles.savingIndicator}>
          <Spinner size={44} className={styles.savingIndicatorSpinner} />
          <div className={styles.savingIndicatorTitle}>녹음을 저장하고 변환하는 중...</div>
          <div className={styles.savingIndicatorBody}>
            잠시만 기다려주세요. 완료되면 전사 단계로 넘어갑니다.
          </div>
        </div>
      )}
    </>
  );
}
