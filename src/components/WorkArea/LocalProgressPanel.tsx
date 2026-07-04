import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity } from "@/constants";
import styles from "./LocalProgressPanel.module.css";

interface LocalProgressPanelProps {
  // 현재 활동성 — Composing 진입 시 이전 실행의 라인을 비운다.
  activity: Activity;
  // 회의록 작성 완료 후(idle) 라인이 없을 때 보여줄 빈 상태 (EmptyState 재사용).
  emptyState: React.ReactNode;
}

/**
 * 로컬 AI 진행 패널 — 터미널 드로어 자리에 들어가는 진행 라인 표시.
 * 로컬 파이프라인은 결정론적 1회성이라 상호작용할 터미널이 없다 — 전사·화자분리(ProcessingPanel)와
 * 같은 결로, Rust cmd_run_local_meeting이 스트리밍하는 "local:output" 라인만 보여준다.
 * - stdout만 표시 (stderr는 모델 로딩 진행바 등 노이즈 — pipeline.log에는 남음)
 * - "작성 중… N자" 진행 카운터는 마지막 줄을 교체(터미널의 \r 갱신과 동일한 체감)
 */
export default function LocalProgressPanel({ activity, emptyState }: LocalProgressPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const prevActivityRef = useRef(activity);

  // Composing 진입(rising edge) 시 이전 실행 라인 정리.
  useEffect(() => {
    if (prevActivityRef.current !== Activity.Composing && activity === Activity.Composing) {
      setLines([]);
    }
    prevActivityRef.current = activity;
  }, [activity]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("local:output", (event) => {
      try {
        const { stream, line } = JSON.parse(event.payload) as { stream: string; line: string };
        if (stream !== "stdout") return;
        const text = line.replace(/\s+$/, "");
        if (!text.trim()) return;
        setLines((prev) => {
          const isCounter = text.trimStart().startsWith("작성 중…");
          const lastIsCounter =
            prev.length > 0 && prev[prev.length - 1].trimStart().startsWith("작성 중…");
          const next = isCounter && lastIsCounter ? [...prev.slice(0, -1), text] : [...prev, text];
          return next.length > 200 ? next.slice(next.length - 200) : next;
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

  // 새 라인 도착 시 하단 고정 스크롤.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0 && activity !== Activity.Composing) {
    return <>{emptyState}</>;
  }

  return (
    <div ref={bodyRef} className={styles.panel} role="log" aria-label="로컬 AI 진행 상황">
      {lines.map((l, i) => (
        <div key={i} className={styles.line}>
          {l}
        </div>
      ))}
      {activity === Activity.Composing && <div className={styles.pulse} aria-hidden="true" />}
    </div>
  );
}
