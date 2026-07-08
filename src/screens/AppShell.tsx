import { useEffect, useState, useRef } from "react";
import { useNavigate, Outlet } from "react-router-dom";
import { useDialog } from "@/contexts/DialogContext";
import { useSession } from "@/contexts/SessionContext";
import { useRecorderContext } from "@/contexts/RecorderContext";
import { Activity, isCli } from "@/constants";
import { saveRecording } from "@/utils/saveRecording";
import { routeAfterCliSelected } from "@/utils/bootstrap";
import { track } from "@/utils/analytics";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@/utils/notification";

// 라우터 root layout — 글로벌 listener·초기화·exit modal 책임. Outlet으로 자식 routes 렌더.
export default function AppShell() {
  const navigate = useNavigate();
  const session = useSession();
  const recorder = useRecorderContext();
  const { confirm } = useDialog();
  const [savingForExit, setSavingForExit] = useState(false);

  // 최신 ref들 — listen 콜백에서 stale closure 회피.
  const recorderRef = useRef(recorder);
  const confirmRef = useRef(confirm);
  const meetingRef = useRef(session.meeting);
  useEffect(() => {
    recorderRef.current = recorder;
  });
  useEffect(() => {
    confirmRef.current = confirm;
  });
  useEffect(() => {
    meetingRef.current = session.meeting;
  });

  // 초기화 — appDir·deps 체크 후 적절한 화면으로 navigate.
  // deps.installed(bin+venv+whisper)와 pyannote 모델 캐시가 모두 있어야 정상 진입.
  useEffect(() => {
    let cancelled = false;
    void track("app_started");
    invoke<string>("cmd_get_signal_dir")
      .then((dir) => {
        if (!cancelled) session.setSignalDir(dir);
      })
      .catch(() => {});
    invoke<string>("cmd_get_active_cli")
      .then((c) => {
        if (!cancelled && isCli(c)) session.setCli(c);
      })
      .catch(() => {});
    invoke<string>("cmd_get_app_dir")
      .then(async (dir) => {
        if (cancelled) return;
        session.setAppDir(dir);
        // CLI 미선택(첫 진입)이면 선택 화면을 먼저. 선택 후엔 deps에 따라 setup/홈.
        const chosen = await invoke<boolean>("cmd_is_cli_chosen").catch(() => false);
        if (cancelled) return;
        if (!chosen) {
          navigate("/select-cli", { replace: true });
          return;
        }
        navigate(await routeAfterCliSelected(), { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        navigate("/error", { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 창 닫기 — 녹음 중이면 자동 저장 후 종료
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("app:close_requested", async () => {
      if (session.activityRef.current === Activity.Recording) {
        const ok = await confirmRef.current({
          title: "녹음 중입니다",
          body: (
            <>
              녹음을 저장하고 종료하시겠습니까?
              <br />
              다음 실행 시 '회의 기록'에서 재개할 수 있습니다.
            </>
          ),
          confirmLabel: "저장 후 종료",
        });
        if (!ok) {
          await invoke<void>("cmd_close_cancelled").catch(() => {});
          return;
        }
        setSavingForExit(true);
        // recorder.stop으로 캡처를 정지하고 saveRecording까지 호출 — 다음 실행 시 '회의 기록'으로 재개 가능.
        // 실패해도 종료는 진행 (앱이 멈추는 게 더 나쁨).
        try {
          const captured = await recorderRef.current.stop();
          if (captured) {
            await saveRecording(meetingRef.current, () => false);
          }
        } catch {}
      }
      try {
        await invoke<void>("cmd_force_close");
      } catch {}
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [session.activityRef]);

  // OSC 신호 — notify (알림). phase_done·refresh는 SessionContext가 처리.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("app:signal", (event) => {
      try {
        const signal = JSON.parse(event.payload) as { type: string; msg?: string };
        if (signal.type === "notify") {
          sendNotification("Junmit", signal.msg ?? "");
        }
      } catch {}
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <>
      {/* 자식 라우트 — /loading, /error, /setup, MainLayout(/, /history, /recording, /session) */}
      <Outlet />

      {savingForExit && (
        <div className="dialog-overlay">
          <div className="dialog-box">
            <h2 className="dialog-title">녹음 저장 중...</h2>
            <p className="dialog-body">
              저장이 완료되면 자동으로 종료됩니다.
              <br />
              잠시만 기다려주세요.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
