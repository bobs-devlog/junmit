import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import type { DepsCheck } from "@/types";
import appStyles from "@/App.module.css";
import styles from "./SetupScreen.module.css";

function extractPercent(line: string): number | null {
  const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

function isNoise(line: string): boolean {
  return /^[#=O\-\s]+$/.test(line);
}

type SetupStep = "ready" | "installing" | "done" | "error";

export default function SetupScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const toast = useToast();
  const [step, setStep] = useState<SetupStep>("ready");
  const [logs, setLogs] = useState<string[]>([]);
  const [currentTask, setCurrentTask] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // install:output 이벤트 수신. StrictMode 안전 패턴.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<string>("install:output", (event) => {
      const raw = event.payload;
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[[\d;]*m/g, "");
      if (!line.trim() || isNoise(line)) return;

      const pct = extractPercent(line);
      if (pct !== null) {
        setProgress(pct);
        return;
      }

      if (line.includes("[INFO]") || line.includes("[완료]") || line.includes("[경고]")) {
        setCurrentTask(line.replace(/\[INFO\]|\[완료\]|\[경고\]/g, "").trim());
        setProgress(null);
      }

      setLogs((prev) => [...prev.slice(-200), line]);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleStartInstall = async () => {
    setStep("installing");
    setLogs([]);
    setCurrentTask("준비 중...");
    setProgress(null);
    setErrorMsg(null);

    try {
      await invoke("cmd_run_install");
      setStep("done");
    } catch (e) {
      setStep("error");
      setErrorMsg(`${e}`);
    }
  };

  const handleCancel = async () => {
    try {
      await invoke("cmd_cancel_install");
    } catch {}
    setStep("ready");
    setCurrentTask("");
    setProgress(null);
    setConfirmCancel(false);
  };

  // 설치 완료 후 "시작하기" — appDir set + deps 재확인 후 home으로 navigate.
  // deps가 미설치 상태로 떨어지면 토스트 안내 후 같은 화면 유지.
  const handleStartApp = async () => {
    try {
      const dir = await invoke<string>("cmd_get_app_dir");
      session.setAppDir(dir);
      const deps = await invoke<DepsCheck>("cmd_check_deps");
      // AppShell의 진입 조건과 동일하게 — bin/번들 모델/venv/whisper 모두 확인.
      if (deps.installed) {
        navigate("/", { replace: true });
      } else {
        toast.error("일부 설치가 완료되지 않았습니다. 다시 시도해주세요.");
      }
    } catch {
      navigate("/", { replace: true });
    }
  };

  return (
    <div className={appStyles.app}>
      <div className={styles.setupScreen} data-tauri-drag-region>
        <div className={styles.setupCard}>
          <h1 className="setup-title">Junmit</h1>
          <p className={styles.setupSubtitle}>초기 설정이 필요합니다</p>

          {step === "ready" && (
            <>
              <p className="setup-desc">
                whisper.cpp, pyannote.audio 등 음성 처리 엔진을 설치합니다. 처음 한 번만 실행하면
                됩니다.
              </p>

              <button className="btn btn-primary btn-large" onClick={handleStartInstall}>
                설치 시작
              </button>
            </>
          )}

          {step === "installing" && (
            <>
              <div className={styles.setupCurrentTask}>{currentTask}</div>

              <div className={styles.setupProgressRow}>
                <div className={styles.setupProgressBar}>
                  <div
                    className={clsx(
                      styles.setupProgressFill,
                      progress === null && styles.indeterminate
                    )}
                    style={progress !== null ? { width: `${progress}%` } : {}}
                  />
                </div>
                {progress !== null && (
                  <span className={styles.setupProgressPct}>{Math.round(progress)}%</span>
                )}
              </div>

              <div className={styles.setupLogs} ref={logRef}>
                {logs.map((line, i) => (
                  <div key={i} className={styles.setupLogLine}>
                    {line}
                  </div>
                ))}
              </div>

              {confirmCancel ? (
                <div className={styles.setupCancelConfirm}>
                  <span>설치를 중단하시겠습니까?</span>
                  <div className={styles.setupCancelButtons}>
                    <button className="btn btn-danger btn-small" onClick={handleCancel}>
                      중단
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => setConfirmCancel(false)}
                    >
                      계속 설치
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-danger" onClick={() => setConfirmCancel(true)}>
                  설치 중단
                </button>
              )}
            </>
          )}

          {step === "done" && (
            <>
              <div className={styles.setupDone}>설치가 완료되었습니다!</div>
              <button className="btn btn-primary btn-large" onClick={handleStartApp}>
                시작하기
              </button>
            </>
          )}

          {step === "error" && (
            <>
              <div className={styles.setupError}>설치 중 오류가 발생했습니다</div>
              <div className="error-msg">{errorMsg}</div>
              <div className={styles.setupLogs} ref={logRef}>
                {logs.map((line, i) => (
                  <div key={i} className={styles.setupLogLine}>
                    {line}
                  </div>
                ))}
              </div>
              <button className="btn btn-secondary" onClick={() => setStep("ready")}>
                다시 시도
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
