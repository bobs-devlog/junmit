import { useState, useEffect, useRef } from "react";
import { LOCAL_MODEL_HIGH, isCli } from "@/constants";
import { useNavigate, useLocation } from "react-router-dom";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSession } from "@/contexts/SessionContext";
import { routeAfterCliSelected } from "@/utils/bootstrap";
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

// mode="base": 기초 설치(venv·whisper·pyannote). mode="model": 로컬 LLM 모델만 다운로드.
// 온보딩·설정이 같은 화면을 재사용하되(중복 방지), 라우트(/setup vs /local-model)와 문구만 분기.
export default function SetupScreen({ mode = "base" }: { mode?: "base" | "model" }) {
  const isModel = mode === "model";
  const copy = isModel
    ? {
        title: "로컬 AI 모델",
        subtitle: "회의록 작성을 위한 로컬 AI를 준비합니다",
        desc: "구독 없이 이 기기에서 회의록을 작성할 로컬 AI 모델(Gemma — 표준 6.8GB / 고품질 11GB)을 내려받습니다. 처음 한 번만 받으면 되고, 설치 중에는 이 창을 닫지 말아 주세요.",
        start: "모델 다운로드",
        // 미도달 — model 모드는 완료 화면 없이 자동 라우팅(handleStartInstall). 타입 대칭용.
        done: "로컬 AI 모델이 준비되었습니다!",
      }
    : {
        title: "Junmit",
        subtitle: "초기 설정이 필요합니다",
        desc: "음성 인식·화자 구분 엔진과 모델을 내려받아 설치합니다. 처음 한 번만 하면 됩니다. 약 1.8GB를 받으므로 네트워크에 따라 몇 분에서 더 걸릴 수 있어요. 설치 중에는 이 창을 닫지 말아 주세요.",
        start: "설치 시작",
        done: "설치가 완료되었습니다!",
      };
  const navigate = useNavigate();
  const location = useLocation();
  // 모델 다운로드 화면은 되돌릴 수 있어야 함 — 온보딩은 백엔드 재선택(/select-cli),
  // 설정 전환은 설정(/settings)으로. 호출부(CliSelector)가 state.returnTo로 전달.
  // state가 없는 진입(재시작 후 부트스트랩 강제 라우팅)은 선택 이력 기준으로 폴백 —
  // 이미 도구를 고른 사용자를 온보딩 게이트로 되돌리면 동선이 꼬인다.
  const navState = location.state as { returnTo?: string; revertCli?: string } | null;
  const [returnFallback, setReturnFallback] = useState("/select-cli");
  useEffect(() => {
    invoke<boolean>("cmd_is_cli_chosen")
      .then((c) => {
        if (c) setReturnFallback("/settings");
      })
      .catch(() => {});
  }, []);
  const returnTo = navState?.returnTo ?? returnFallback;
  const session = useSession();

  // 다운로드 없이 "뒤로" — 성급하게 영속된 선택들을 복원한다. 안 하면 설치도 안 한
  // 도구/변형이 "사용 중"·"다운로드 필요"로 남는다 (전환 영속이 라우팅 판정보다 앞서는 구조 보완).
  // ① 미설치 변형 선택 → 설치된 변형으로 ② CLI 전환(설정 경유) → 이전 CLI(revertCli)로.
  // 복원을 await 후 이동 — 다음 화면 mount의 상태 조회가 복원 전 값을 읽는 순간 오표시 방지.
  const handleModelBack = async () => {
    const revert = navState?.revertCli;
    const jobs: Promise<unknown>[] = [invoke("cmd_revert_local_model_if_missing")];
    if (revert && isCli(revert)) {
      jobs.push(invoke("cmd_set_active_cli", { cli: revert }));
      session.setCli(revert);
    }
    await Promise.allSettled(jobs);
    navigate(returnTo, { replace: true });
  };
  // 로컬 AI(mlx) 온보딩이면 기초 설치 뒤 모델 다운로드가 이어짐 — 총 용량 기대치를
  // 기초 화면에서 미리 알린다 (변형은 이 화면 진입 전에 이미 선택·저장돼 정확한 용량 표기 가능).
  const [localModelNote, setLocalModelNote] = useState("");
  useEffect(() => {
    if (isModel || session.cli !== "mlx") return;
    invoke<string>("cmd_get_local_model")
      .then((m) => {
        const high = m === LOCAL_MODEL_HIGH;
        setLocalModelNote(
          ` 선택한 로컬 AI 모델(${high ? "고품질, 약 11GB" : "표준, 약 6.8GB"})도 이어서 함께 내려받아요.`
        );
      })
      .catch(() => {});
  }, [isModel, session.cli]);

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
        // 용량 진행 라인("받는 중... 3400MB / 6700MB (52%)")은 본문으로도 표시 — %만으로는
        // 대용량 구간에서 멈춘 것처럼 보인다는 피드백. 실제 받은 크기가 늘어나는 게 보이면
        // 진행 중임이 자명해진다. 말미 "(52%)"는 게이지 우측 %와 중복이라 표시에서만 제거.
        if (line.includes("MB")) setCurrentTask(line.trim().replace(/\s*\(\d+%\)$/, ""));
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

  // 사용자 중단 플래그 — 연속 설치(base→model)의 두 invoke 사이 gap에 취소가 떨어지면
  // Rust take()가 no-op이 되어 취소가 증발한다. 이 플래그가 다음 단계 진입을 막고,
  // 취소로 reject된 invoke가 catch에서 오류 화면을 띄우는 경합도 걸러낸다.
  const cancelRequestedRef = useRef(false);
  // 실패한 단계 — 연속 설치(base→model)에서 model 실패 시 base 화면에도 "뒤로"(백엔드
  // 재선택 탈출구)를 열기 위함. 없으면 반복 실패 사용자가 "다시 시도"만 가능한 막다른 길.
  const phaseRef = useRef<"base" | "model">(isModel ? "model" : "base");
  const [errorPhase, setErrorPhase] = useState<"base" | "model">(isModel ? "model" : "base");

  const handleStartInstall = async () => {
    cancelRequestedRef.current = false;
    phaseRef.current = isModel ? "model" : "base";
    setStep("installing");
    setLogs([]);
    setCurrentTask("준비 중...");
    setProgress(null);
    setErrorMsg(null);

    try {
      await invoke("cmd_run_install", { mode });
      // 로컬 AI 온보딩이면 모델 다운로드까지 이 화면에서 연속 실행 — 완료 화면·시작하기를
      // 두 번 거치지 않는다. (설정 경유 단독 다운로드·중단 후 재개는 /local-model이 담당)
      if (!isModel && session.cli === "mlx") {
        if (cancelRequestedRef.current) return; // base 완료와 model 시작 사이 취소
        const present = await invoke<boolean>("cmd_check_local_model").catch(() => false);
        if (!present) {
          phaseRef.current = "model";
          setCurrentTask("로컬 AI 모델 다운로드 준비 중...");
          setProgress(null);
          await invoke("cmd_run_install", { mode: "model" });
        }
      }
      if (isModel) {
        // 모델 다운로드는 완료 화면 없이 바로 다음 화면으로 — 기초 설치의 완료+"시작하기"에
        // 이어 두 번째 관문을 만들지 않는다(중복 클릭). 단 라우팅이 여전히 이 화면을
        // 가리키면(설치 직후 모델이 사라진 비정상 — 같은 경로 재이동은 무반응으로 보임)
        // 오류로 표면화해 재시도를 유도한다.
        const dir = await invoke<string>("cmd_get_app_dir").catch(() => null);
        if (dir) session.setAppDir(dir);
        const route = await routeAfterCliSelected();
        if (route === "/local-model") {
          setErrorPhase("model");
          setStep("error");
          setErrorMsg("설치 확인에 실패했습니다 (모델 파일이 온전하지 않아요). 다시 시도해주세요.");
        } else {
          navigate(route, { replace: true });
        }
        return;
      }
      setStep("done");
    } catch (e) {
      // 사용자 중단으로 죽은 invoke의 reject — 오류가 아니라 의도된 취소.
      // handleCancel이 이미 ready로 되돌렸으므로 오류 화면으로 덮지 않는다.
      if (cancelRequestedRef.current) return;
      setErrorPhase(phaseRef.current);
      setStep("error");
      setErrorMsg(`${e}`);
    }
  };

  const handleCancel = async () => {
    cancelRequestedRef.current = true;
    try {
      await invoke("cmd_cancel_install");
    } catch {}
    setStep("ready");
    setCurrentTask("");
    setProgress(null);
    setConfirmCancel(false);
  };

  // 완료 후 "시작하기" — appDir set 후 routeAfterCliSelected로 다음 화면 결정.
  // base 완료 & mlx면 로컬 모델이 아직 없어 /local-model로 이어지고, model 완료면 모두 갖춰져 홈.
  // 아직 미설치면 /setup으로 되돌아 재시도 유도(하드코딩 "/" 대신 실제 상태 기반 라우팅).
  const handleStartApp = async () => {
    try {
      const dir = await invoke<string>("cmd_get_app_dir");
      session.setAppDir(dir);
      navigate(await routeAfterCliSelected(), { replace: true });
    } catch {
      navigate("/", { replace: true });
    }
  };

  return (
    <div className={appStyles.app}>
      <div className={styles.setupScreen} data-tauri-drag-region>
        <div className={styles.setupCard}>
          <h1 className="setup-title">{copy.title}</h1>
          <p className={styles.setupSubtitle}>{copy.subtitle}</p>

          {step === "ready" && (
            <>
              <p className="setup-desc">
                {copy.desc}
                {localModelNote}
              </p>

              <button className="btn btn-primary btn-large" onClick={handleStartInstall}>
                {copy.start}
              </button>
              {/* 모델 다운로드는 되돌릴 수 있어야 함(기초 설치는 필수라 뒤로 없음). */}
              {isModel && (
                <button className="btn btn-secondary" onClick={handleModelBack}>
                  뒤로
                </button>
              )}
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
              <div className={styles.setupDone}>{copy.done}</div>
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
              {(isModel || errorPhase === "model") && (
                <button className="btn btn-secondary" onClick={handleModelBack}>
                  뒤로
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
