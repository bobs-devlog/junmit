import { useCallback, useEffect, useRef, useState } from "react";
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
import useRecordingAutoStop from "@/hooks/useRecordingAutoStop";
import useRecordingTray from "@/hooks/useRecordingTray";
import {
  DEFAULT_DURATION_MIN,
  Activity,
  MIC_PRIVACY_SETTINGS_URL,
  SYSTEM_AUDIO_PRIVACY_SETTINGS_URL,
} from "@/constants";
import { saveRecording } from "@/utils/saveRecording";
import { MIC_PERMISSION_DENIED } from "@/hooks/useRecorder";
import { hideReminderWindow } from "@/utils/reminderWindow";
import { logError } from "@/utils/logging";
import { track, durationBucket } from "@/utils/analytics";
import { loadBriefing, type Briefing } from "@/utils/briefing";
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

  // 지난 회의 브리핑 — 같은 시리즈(제목 동일) 지난 회의의 액션 아이템. 반복 회의는 대개
  // 초반에 지난 액션을 점검하므로, 그 시점에 참조할 수 있는 녹음 화면에 노출한다.
  // 제목은 녹음 진입 시 고정이라 마운트 1회 로드로 충분. 실패·미매칭은 무해(카드 미표시).
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  useEffect(() => {
    const title = meeting?.title;
    if (!title) return;
    let cancelled = false;
    void loadBriefing(title).then((b) => {
      if (!cancelled) setBriefing(b);
    });
    return () => {
      cancelled = true;
    };
    // 마운트 1회 — meeting은 녹음 화면 진입 시 고정
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        void track("recording_started");
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (cancelled) return;
        if (err.name === MIC_PERMISSION_DENIED) {
          const openSettings = await confirm({
            title: "마이크 권한이 필요합니다",
            body: (
              <>
                Junmit가 회의를 녹음하려면 마이크 접근 권한이 필요합니다.
                <br />
                시스템 설정에서 허용하고 '종료 및 다시 열기'를 선택해주세요.
              </>
            ),
            confirmLabel: "시스템 설정 열기",
            cancelLabel: "닫기",
          });
          if (openSettings && !cancelled) {
            try {
              await invoke<void>("cmd_open_path", { path: MIC_PRIVACY_SETTINGS_URL });
            } catch (openErr) {
              logError("RecordingScreen.openSettings", openErr);
              toast.error(
                "시스템 설정을 열지 못했어요. 설정 > 개인정보 보호 및 보안 > 마이크에서 직접 허용해 주세요."
              );
            }
            // macOS는 실행 중 앱의 마이크 권한 변경을 앱 재실행까지 유예한다('종료 및 다시
            // 열기' 다이얼로그 — 2026-07 macOS 26 실측. 과거 주석의 "즉시 반영"은 오판).
            // '종료 및 다시 열기'를 골랐다면 앱이 재시작돼 이 재시도에 도달하지 않고,
            // '나중에'를 골랐다면 재시도가 실패한다 — 그 경우를 문구로 안내.
            const retry = await confirm({
              title: "권한을 허용하셨나요?",
              body: "'나중에'를 선택했다면 권한이 아직 적용되지 않았을 수 있어요. 다시 시도해보고, 안 되면 앱을 종료했다 다시 열어주세요.",
              confirmLabel: "다시 시도",
              cancelLabel: "나중에",
            });
            if (retry && !cancelled) {
              try {
                await recorder.start();
                void track("recording_started");
                return; // 재시도 성공 — 녹음 진행
              } catch (retryErr) {
                logError("RecordingScreen.micRetry", retryErr);
              }
            }
          }
        } else {
          logError("RecordingScreen.micAccess", err);
          toast.error("마이크에 접근하지 못했어요. 다시 시도해 주세요.");
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
    const elapsedSec = recorder.elapsed; // stop 후 리셋되기 전에 캡처
    const captured = await recorder.stop();
    if (!captured || isCancelled()) {
      if (!isCancelled()) {
        resetSession();
        navigate("/", { replace: true });
      }
      return;
    }
    try {
      const saved = await saveRecording(meeting, isCancelled, notesRef.current);
      if (!saved || isCancelled()) return;
      void track("recording_completed", {
        duration_bucket: durationBucket(elapsedSec),
        capture_mode: saved.captureMode,
      });
      finishRecording(saved.dir);
      navigate("/session", { replace: true });
    } catch (e) {
      logError("RecordingScreen.saveRecording", e);
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

  // 자동 종료 안전망 — 무음·상한·시스템 슬립 시 저장 후 종료("종료 깜빡 후 퇴근" 방어).
  useRecordingAutoStop({
    activity,
    isRecording: recorder.isRecording,
    level: recorder.level,
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

      {/* 메인 영역(녹음 중엔 메모 패널, Saving은 안내 표시).
          래퍼 필수: 부모(.content-body)는 row flex라 배너·메모를 세로로 쌓으려면 열 컨테이너 필요. */}
      {activity === Activity.Recording && (
        <div className={styles.recordingMain}>
          {/* 시스템 오디오 캡처 실패(권한 거부 등)는 조용한 마이크-only 강등. 원격 회의라면
              상대 음성이 통째로 빠진 걸 회의록에서야 알게 되므로 녹음 중에 미리 알린다. */}
          {recorder.systemAudioActive === false && (
            <div className={styles.captureNotice}>
              🔇 시스템 오디오가 캡처되지 않아요. 대면 회의라면 문제없지만, 원격 회의(Zoom·Meet
              등)는 상대방 음성이 녹음되지 않습니다.{" "}
              <button
                type="button"
                className={styles.captureNoticeLink}
                onClick={() =>
                  invoke("cmd_open_path", { path: SYSTEM_AUDIO_PRIVACY_SETTINGS_URL }).catch(
                    () => {}
                  )
                }
              >
                시스템 설정에서 허용
              </button>
              하면 다음 녹음부터 함께 녹음돼요 (적용이 안 되면 앱을 종료했다 다시 열어주세요).
            </div>
          )}
          <RecordingNotes
            attendees={meeting?.attendees ?? NO_ATTENDEES}
            notes={notes}
            briefing={briefing}
            onAddSpeaker={addSpeaker}
            onAddText={addText}
            onEditText={editText}
            onRemove={removeNote}
          />
        </div>
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
