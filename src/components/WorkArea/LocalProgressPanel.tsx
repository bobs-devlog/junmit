import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity } from "@/constants";
import ProgressPanel from "./ProgressPanel";
import { capItems, type PanelItem, type Stage } from "./progressPanelModel";

interface LocalProgressPanelProps {
  activity: Activity;
  // phase_done 정상 완료 여부. 실패·취소도 Composing→Idle이라 activity만으론 구분이 안 된다
  // (❌ 아래 거짓 ✓가 찍힌다).
  completed: boolean;
  emptyState: React.ReactNode;
}

// 첫 마커 도착 전(프로세스 기동)과 마커 없는 조기 종료 경로(무발화 가드)를 채우는 자리표시.
const BOOT_STAGES: Stage[] = [{ key: "boot", label: "로컬 AI 시작", state: "running" }];

// 라이브 진행 카운터("작성 중… N자"): 터미널 \r 갱신을 흉내내는 제자리 교체 대상.
function isCounterText(text: string): boolean {
  return text.trimStart().startsWith("작성 중…");
}

// @@progress 마커는 단계 계획 전체 + 현재 단계를 매번 자가완결로 싣는다(순서 유실에 안전).
function parseProgressMarker(text: string): Stage[] | null {
  if (!text.startsWith("@@progress ")) return null;
  try {
    const payload = JSON.parse(text.slice("@@progress ".length)) as {
      stages?: { key?: unknown; label?: unknown }[];
      current?: unknown;
      hint?: unknown;
    };
    const plan = payload.stages;
    if (!Array.isArray(plan) || typeof payload.current !== "string") return null;
    const currentIndex = plan.findIndex((stage) => stage?.key === payload.current);
    if (currentIndex < 0) return null;
    return plan.map((stage, index) => ({
      key: String(stage.key),
      label: String(stage.label),
      state: index < currentIndex ? "done" : index === currentIndex ? "running" : "pending",
      hint: index === currentIndex && typeof payload.hint === "string" ? payload.hint : undefined,
    }));
  } catch {
    return null;
  }
}

/**
 * 로컬 AI(mlx) 진행 패널 컨테이너: "local:output" 해석만 하고 렌더는 셸에 위임.
 * 로그는 stdout만 표시(stderr는 모델 로딩 진행바 노이즈, pipeline.log에는 남음)하되
 * stderr 도착도 하트비트에는 반영: 모델 로딩 동안의 stdout 침묵을 메운다.
 */
export default function LocalProgressPanel({
  activity,
  completed,
  emptyState,
}: LocalProgressPanelProps) {
  const [items, setItems] = useState<PanelItem[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  // Composing 진입 시 이전 실행 표시 정리, 이탈 시 마무리("렌더 중 상태 조정" 패턴).
  // 완료: 카운터를 "본문 N자"로 고정(라이브 표시 잔존 방지) + 완료 줄 추가 + 전 단계 ✓.
  // 실패·취소: 카운터 제거 + 진행 단계 "중단됨". 카운터는 위치 무관 제거: ❌ 줄이 뒤에 붙는
  // 실패 경로에선 마지막 항목이 아니다(한 실행에 카운터는 연속 교체로 최대 1개라 filter로 충분).
  const [prevActivity, setPrevActivity] = useState(activity);
  if (activity !== prevActivity) {
    setPrevActivity(activity);
    if (activity === Activity.Composing) {
      setItems([]);
      setStages(BOOT_STAGES);
      setLastEventAt(null);
    } else if (prevActivity === Activity.Composing) {
      if (completed) {
        setItems((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          const frozen =
            last.type === "text" && isCounterText(last.text)
              ? [
                  ...prev.slice(0, -1),
                  {
                    type: "text" as const,
                    text: `   본문 ${last.text.trimStart().replace(/^작성 중…\s*/, "")}`,
                  },
                ]
              : prev;
          return capItems([...frozen, { type: "text", text: "✓ 회의록 작성 완료" }]);
        });
        setStages((prev) => prev.map((stage) => ({ ...stage, state: "done", hint: undefined })));
      } else {
        setItems((prev) =>
          prev.filter((item) => !(item.type === "text" && isCounterText(item.text)))
        );
        setStages((prev) =>
          prev.map((stage) =>
            stage.state === "running" ? { ...stage, state: "canceled", hint: undefined } : stage
          )
        );
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("local:output", (event) => {
      setLastEventAt(Date.now()); // stderr 포함 생존 신호
      try {
        const { stream, line } = JSON.parse(event.payload) as { stream: string; line: string };
        if (stream !== "stdout") return;
        const text = line.replace(/\s+$/, "");
        if (!text.trim()) return;
        const markerStages = parseProgressMarker(text);
        if (markerStages) {
          setStages(markerStages);
          return;
        }
        setItems((prev) => {
          const last = prev[prev.length - 1];
          const replaceCounter =
            isCounterText(text) && last?.type === "text" && isCounterText(last.text);
          const nextItem: PanelItem = { type: "text", text };
          return capItems(replaceCounter ? [...prev.slice(0, -1), nextItem] : [...prev, nextItem]);
        });
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
    <ProgressPanel
      stages={stages}
      items={items}
      lastEventAt={lastEventAt}
      completed={completed}
      ariaLabel="로컬 AI 진행 상황"
      emptyState={emptyState}
    />
  );
}
