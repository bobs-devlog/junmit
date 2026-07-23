import { useState, useEffect, useRef } from "react";
import clsx from "clsx";
import { STEPS, Step } from "@/constants";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionSteps } from "@/types";
import Spinner from "@/components/Spinner";
import { track } from "@/utils/analytics";
import styles from "./ProcessingPanel.module.css";

// ANSI 이스케이프 코드 제거
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[[\d;]*m/g, "");
}

// 오디오 처리 단계만 (transcribe + diarize). STEPS의 처음 두 단계.
const PROCESSING_STEPS = STEPS.filter((s) => s.id === Step.Transcribe || s.id === Step.Diarize);

type StepState = "running" | "done" | "error";

// ─── 스크립트 출력 파서 ─────────────────────────────────────
// 파이프라인 출력 원문은 pipeline.log에 전부 기록되고(진단용 — 설정 > 로그 폴더 열기),
// 화면엔 아래 파서가 인식한 정보만 사용자 언어로 노출한다(내부 경로·도구명·기술 로그 숨김).
// 형식 변경 시 transcribe.sh·pyannote_diarize.py·diarize.sh와 함께 수정.

// 전사 진행률 — transcribe.sh가 whisper -pp stderr를 필터한 라인 (디코드 위치, 30초 창마다)
const WHISPER_PROGRESS_RE = /^progress\s*=\s*(\d{1,3})%$/;
// 화자분리 진행률 — pyannote_diarize.py hook. 단계별로 각각 0→100.
const PYANNOTE_PROGRESS_RE = /^pyannote\.audio: (구간 분석|화자 특징 추출) (\d{1,3})%$/;
// 전사 세그먼트 — whisper stdout. 발화 속 "N%" 같은 텍스트를 진행률로 오인하지 않도록
// 모든 파서가 라인 전체 형식을 매칭한다.
const SEGMENT_RE = /^\[(\d{2}):(\d{2}):(\d{2})\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s+(.+)$/;
// 화자 수 탐색 기준 — diarize.sh. attendees=참석자 수 기반 / default=참석자 미입력 폴백.
const SPEAKER_HINT_RE = /^\[speaker-hint\] (attendees|default) (\d+)$/;
// GPU 가속 불가 폴백 — pyannote_diarize.py가 MPS 미지원 시 출력.
const CPU_FALLBACK_PREFIX = "pyannote.audio: CPU 모드";

// 화자분리 하위 단계. 전이는 진행률 라인 도착으로 유도된다 — "준비"(모델·오디오 로딩)는
// 첫 "구간 분석" 라인이 오면 완료로 간주. "마무리"는 특징 추출 100% 이후의 꼬리 작업
// (클러스터링·합치기 제안 후보 계산·전사 병합 — 화자 수에 따라 수 초~수십 초)로,
// 진행률 신호가 없어 스피너만 표시한다. 이 단계가 없으면 "100%에서 멈춤"으로 보인다.
const DIARIZE_STAGES = [
  { id: "prep", label: "준비" },
  { id: "seg", label: "구간 분석" },
  { id: "emb", label: "화자 특징 추출" },
  { id: "finish", label: "마무리" },
] as const;
type DiarizeStageId = (typeof DIARIZE_STAGES)[number]["id"];

interface TranscriptEntry {
  time: string;
  text: string;
}

function formatTime(h: number, m: number, s: number): string {
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 얇은 바 + 퍼센트 — SetupScreen 다운로드 게이지와 같은 시각 어휘.
function ProgressBar({ pct }: { pct: number }) {
  return (
    <span className={styles.ppBar}>
      <span className={styles.ppBarTrack}>
        <span className={styles.ppBarFill} style={{ width: `${pct}%` }} />
      </span>
      <span className={styles.ppBarPct}>{pct}%</span>
    </span>
  );
}

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
  // 전사 진행률 (null = 전사 단계 미시작). 시작 시 0으로 초기화해 바를 즉시 노출한다 —
  // whisper 첫 콜백은 첫 30초 창 디코드 후에야 오고, 그 값도 회의 길이에 따라
  // 1~수십 %라(창 1개 ÷ 전체 창 수) 첫 콜백까지 바가 없으면 "멈춤"으로 보인다.
  const [transcribePct, setTranscribePct] = useState<number | null>(null);
  // 화자분리 하위 단계 + 해당 단계 진행률
  const [diarizeStage, setDiarizeStage] = useState<DiarizeStageId>("prep");
  const [diarizePct, setDiarizePct] = useState(0);
  // 실시간 전사 미리보기 — 단계가 넘어가도 유지 (화자분리 중엔 완성된 전사가 남아 있는 게 자연스러움)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [speakerHint, setSpeakerHint] = useState<{
    source: "attendees" | "default";
    count: number;
  } | null>(null);
  const [cpuFallback, setCpuFallback] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // StrictMode 안전: 같은 sessionDir로 두 번 invoke되지 않도록 가드.
  // (cancelled 플래그는 await 안에 묶여서 invoke 시작을 못 막음.)
  const startedRef = useRef<string | null>(null);

  // 미리보기 자동 스크롤
  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.scrollTop = previewRef.current.scrollHeight;
    }
  }, [transcript]);

  // pipeline:output 이벤트 수신 → 파서가 인식한 정보만 화면 상태로 반영.
  // StrictMode 안전: cleanup이 Promise resolve 전에 호출되면 cancelled 플래그로 표시,
  // resolve 후 즉시 unlisten해서 listener 누수 방지 (이중 emit 원인이 됨).
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<string>("pipeline:output", (event) => {
      try {
        const data = JSON.parse(event.payload) as { line: string };
        const line = stripAnsi(data.line).trim();
        if (!line) return;

        const w = line.match(WHISPER_PROGRESS_RE);
        if (w) {
          setTranscribePct(Math.min(100, Number(w[1])));
          return;
        }
        const p = line.match(PYANNOTE_PROGRESS_RE);
        if (p) {
          setDiarizeStage(p[1] === "구간 분석" ? "seg" : "emb");
          setDiarizePct(Math.min(100, Number(p[2])));
          return;
        }
        const seg = line.match(SEGMENT_RE);
        if (seg) {
          setTranscript((prev) => [
            ...prev,
            {
              time: formatTime(Number(seg[1]), Number(seg[2]), Number(seg[3])),
              text: seg[4].trim(),
            },
          ]);
          return;
        }
        const hint = line.match(SPEAKER_HINT_RE);
        if (hint) {
          setSpeakerHint({ source: hint[1] as "attendees" | "default", count: Number(hint[2]) });
          return;
        }
        if (line.startsWith(CPU_FALLBACK_PREFIX)) {
          setCpuFallback(true);
          return;
        }
        // 그 외(도구 초기화·경로 등 기술 로그)는 화면 미표시 — pipeline.log에만 남는다.
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
        if (step.id === Step.Transcribe) setTranscribePct(0);
        if (step.id === Step.Diarize) {
          setDiarizeStage("prep");
          setDiarizePct(0);
        }
        onStepChange?.(step.id);

        try {
          const outcome = await invoke<"completed" | "cancelled">("cmd_run_pipeline", {
            sessionDir,
            step: step.id,
          });
          // 취소는 실패가 아니다: 상태 정리·화면 전환은 취소를 부른 쪽(중단 버튼·이탈
          // cleanup)이 이미 마쳤으므로, 다음 단계로 가지 않고 조용히 종료한다.
          if (outcome === "cancelled") return;
          setStepStatus((prev) => ({ ...prev, [step.id]: "done" }));
          void track("pipeline_completed", { step: step.id });
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
          void track("pipeline_failed", { step: step.id });
          onError?.(`${step.label} 실패: ${e}`);
          return;
        }
      }

      onComplete?.();
    };

    runSteps();
  }, [sessionDir]);

  // 현재 파싱된 단계가 100%에 닿으면 활성 표시를 다음 단계로 넘긴다 — 단계 사이의
  // 무신호 구간(구간 분석→특징 추출 준비, 특징 추출→마무리 꼬리 작업)이 "100%에서
  // 멈춤"으로 보이지 않게. 바는 파싱된 단계(진행률 신호가 실제로 오는 단계)에만 붙는다.
  const parsedStageIdx = DIARIZE_STAGES.findIndex((s) => s.id === diarizeStage);
  const activeStageIdx = Math.min(
    diarizePct >= 100 ? parsedStageIdx + 1 : parsedStageIdx,
    DIARIZE_STAGES.length - 1
  );
  const transcribeRunning = stepStatus[Step.Transcribe] === "running";
  const diarizeRunning = stepStatus[Step.Diarize] === "running";

  return (
    <div className={styles.processingPanel}>
      <div className={styles.ppSteps}>
        {PROCESSING_STEPS.map((step, i) => {
          const status = stepStatus[step.id];
          const isCurrent = i === currentStep && status === "running";
          const isDiarize = step.id === Step.Diarize;
          return (
            <div key={step.id}>
              <div
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
                  {isDiarize && speakerHint?.source === "attendees" && (
                    <span className={styles.ppStepNote}> · 참석자 {speakerHint.count}명 기준</span>
                  )}
                </span>
                {isCurrent && !isDiarize && transcribePct != null && (
                  <ProgressBar pct={transcribePct} />
                )}
              </div>
              {/* 화자분리 하위 단계 체크리스트 — 단계별 속도가 크게 달라(특징 추출이 대부분)
                  단일 게이지로 합치면 정체·역행처럼 보인다. 진행 중일 때만 펼친다. */}
              {isDiarize && isCurrent && (
                <div className={styles.ppSubsteps}>
                  {DIARIZE_STAGES.map((stage, si) => {
                    const stageDone = si < activeStageIdx;
                    const stageActive = si === activeStageIdx;
                    return (
                      <div
                        key={stage.id}
                        className={clsx(
                          styles.ppSubstep,
                          stageDone && styles.ppSubstepDone,
                          stageActive && styles.ppSubstepActive
                        )}
                      >
                        <span className={styles.ppSubstepIcon}>
                          {stageDone ? "✓" : stageActive ? <Spinner size={11} /> : "·"}
                        </span>
                        <span>{stage.label}</span>
                        {stageActive && stage.id === diarizeStage && stage.id !== "prep" && (
                          <ProgressBar pct={diarizePct} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {speakerHint?.source === "default" && (
        <div className={styles.ppHint}>
          참석자 정보가 없어 최대 {speakerHint.count}명까지 화자를 탐색합니다. 회의 시작 시 참석자를
          입력하면 화자 구분이 더 정확해져요.
        </div>
      )}
      {cpuFallback && (
        <div className={styles.ppHint}>
          이 Mac에서는 GPU 가속을 쓸 수 없어 처리가 평소보다 오래 걸릴 수 있어요.
        </div>
      )}

      {/* 실시간 전사 미리보기 — 받아적힌 문장이 자막처럼 쌓인다. 화자분리 중엔 완성본 유지. */}
      <div className={styles.ppPreview} ref={previewRef}>
        {transcript.map((entry, i) => (
          <div key={i} className={styles.ppPreviewLine}>
            <span className={styles.ppPreviewTime}>{entry.time}</span>
            <span>{entry.text}</span>
          </div>
        ))}
        {transcript.length === 0 && transcribeRunning && (
          <div className={styles.ppPreviewEmpty}>음성 인식을 준비하는 중...</div>
        )}
        {/* 재개 케이스(전사는 이전 실행에서 완료 — 스트리밍된 미리보기 없음) */}
        {transcript.length === 0 && diarizeRunning && (
          <div className={styles.ppPreviewEmpty}>화자를 구분하는 중...</div>
        )}
      </div>
    </div>
  );
}
