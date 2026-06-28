import { useState, useEffect, useRef } from "react";
import clsx from "clsx";
import { STEPS, Step } from "@/constants";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionSteps } from "@/types";
import Spinner from "@/components/Spinner";
import styles from "./ProcessingPanel.module.css";

// ANSI 이스케이프 코드 제거
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[[\d;]*m/g, "");
}

// 오디오 처리 단계만 (transcribe + diarize). STEPS의 처음 두 단계.
const PROCESSING_STEPS = STEPS.filter((s) => s.id === Step.Transcribe || s.id === Step.Diarize);

type StepState = "running" | "done" | "error";

interface ProcessingPanelProps {
  sessionDir: string | null;
  completedSteps: SessionSteps | null;
  onComplete: () => void;
  onError: (msg: string) => void;
  // 전사 단계에서 무음("발화 없음") 감지 시 호출 — diarize는 건너뛴다 (onComplete 대신).
  onNoSpeech: () => void;
  // 부모에 sub-step 진행 전달 (transcribe / diarize). 부모가 StepId로 매핑.
  onStepChange: (stepId: string) => void;
  // 각 단계 완료 시 호출 — 사이드바 stepper ✓ 즉시 반영. (한 단계 끝날 때마다 setSteps 업데이트)
  onStepDone: (stepId: string) => void;
}

export default function ProcessingPanel({
  sessionDir,
  completedSteps,
  onComplete,
  onError,
  onNoSpeech,
  onStepChange,
  onStepDone,
}: ProcessingPanelProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStatus, setStepStatus] = useState<Record<string, StepState>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  // StrictMode 안전: 같은 sessionDir로 두 번 invoke되지 않도록 가드.
  // (cancelled 플래그는 await 안에 묶여서 invoke 시작을 못 막음.)
  const startedRef = useRef<string | null>(null);

  // 로그 자동 스크롤
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // pipeline:output 이벤트 수신.
  // StrictMode 안전: cleanup이 Promise resolve 전에 호출되면 cancelled 플래그로 표시,
  // resolve 후 즉시 unlisten해서 listener 누수 방지 (이중 emit 원인이 됨).
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<string>("pipeline:output", (event) => {
      try {
        const data = JSON.parse(event.payload) as { line: string };
        const clean = stripAnsi(data.line);
        if (clean.trim()) {
          setLogs((prev) => [...prev, clean]);
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

  // 단계 순차 실행. 한 번 시작되면 끝까지 진행 (cancelled 플래그는 StrictMode와 충돌 — 첫 mount의 cleanup이 다음 단계로 진행 못 하게 막음).
  // 사용자 명시적 취소는 cmd_cancel_pipeline이 담당.
  useEffect(() => {
    if (!sessionDir) return;
    if (startedRef.current === sessionDir) return;
    startedRef.current = sessionDir;

    const runSteps = async () => {
      for (let i = 0; i < PROCESSING_STEPS.length; i++) {
        const step = PROCESSING_STEPS[i];
        setCurrentStep(i);

        // 이미 완료된 단계는 스킵 (재개 시 전사 재실행 방지). STEPS의 field가 SessionSteps 키와 매핑.
        if (completedSteps?.[step.field]) {
          setStepStatus((prev) => ({ ...prev, [step.id]: "done" }));
          continue;
        }

        setStepStatus((prev) => ({ ...prev, [step.id]: "running" }));
        setLogs([]);
        onStepChange?.(step.id);

        try {
          await invoke<void>("cmd_run_pipeline", {
            sessionDir,
            step: step.id,
          });
          setStepStatus((prev) => ({ ...prev, [step.id]: "done" }));
          // 단계별 완료를 부모에 통지 — SessionContext가 setSteps 업데이트하여 사이드바 stepper ✓ 즉시 반영.
          onStepDone?.(step.id);

          // 전사 직후 무음 판정 확인 — transcribe.sh가 transcribe_result.json에 기록.
          // 무음이면 diarize·회의록을 건너뛰고 "발화 없음" 상태로 종료(onComplete 미호출).
          if (step.id === Step.Transcribe) {
            const noSpeech = await invoke<string | null>("cmd_read_session_file", {
              sessionPath: sessionDir,
              filename: "transcribe_result.json",
            })
              .then((raw) => {
                if (!raw) return false;
                try {
                  return JSON.parse(raw)?.no_speech === true;
                } catch {
                  return false;
                }
              })
              .catch(() => false);
            if (noSpeech) {
              onNoSpeech?.();
              return;
            }
          }
        } catch (e) {
          setStepStatus((prev) => ({ ...prev, [step.id]: "error" }));
          onError?.(`${step.label} 실패: ${e}`);
          return;
        }
      }

      onComplete?.();
    };

    runSteps();
  }, [sessionDir]);

  return (
    <div className={styles.processingPanel}>
      <div className={styles.ppSteps}>
        {PROCESSING_STEPS.map((step, i) => {
          const status = stepStatus[step.id];
          const isCurrent = i === currentStep && status === "running";
          return (
            <div
              key={step.id}
              className={clsx(
                styles.ppStep,
                status === "done" && styles.done,
                isCurrent && styles.current,
                status === "error" && styles.error
              )}
            >
              <span className={styles.ppStepIcon}>
                {status === "done" ? (
                  "✓"
                ) : status === "error" ? (
                  "✕"
                ) : isCurrent ? (
                  <Spinner size={13} />
                ) : (
                  "·"
                )}
              </span>
              <span>
                {step.icon} {step.description}
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.ppLogs} ref={logRef}>
        {logs.map((line, i) => (
          <div key={i} className={styles.ppLogLine}>
            {line}
          </div>
        ))}
        {stepStatus[PROCESSING_STEPS[currentStep]?.id] === "running" && (
          <div className={clsx(styles.ppLogLine, styles.ppRunning)}>처리 중...</div>
        )}
      </div>
    </div>
  );
}
