import { useState, useEffect } from "react";
import clsx from "clsx";
import { visibleSteps } from "@/constants";
import { useDialog } from "@/contexts/DialogContext";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "@/types";
import styles from "./SessionList.module.css";

interface SessionListProps {
  onSelect: (session: Session) => void;
}

export default function SessionList({ onSelect }: SessionListProps) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const { confirm } = useDialog();
  const toast = useToast();
  // 활성 백엔드에 따라 카드 단계 표시 필터 — mlx는 AI 다듬기 단계가 없다.
  const { cli } = useSession();

  useEffect(() => {
    invoke?.<Session[]>("cmd_find_sessions")
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  // 카드 hover 시 노출되는 삭제 버튼. 카드 클릭(onSelect) 이벤트와 분리.
  const handleDelete = async (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    const ok = await confirm({
      title: "이 회의를 삭제할까요?",
      body: `"${session.title}" 회의의 모든 데이터(녹음, 전사, 회의록)가 삭제됩니다.`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke<void>("cmd_delete_session", { sessionPath: session.path });
      setSessions((prev) => (prev ?? []).filter((s) => s.path !== session.path));
    } catch (err) {
      console.error("삭제 실패:", err);
      toast.error("회의를 삭제하지 못했어요. 다시 시도해 주세요.");
    }
  };

  if (sessions === null) {
    return (
      <div className={styles.sessionList}>
        <div className="ms-loading">회의 기록 불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className={styles.sessionList}>
      {sessions.length === 0 ? (
        <div className="ms-loading">
          아직 회의 기록이 없어요. 새 회의를 녹음하면 여기에 표시됩니다.
        </div>
      ) : (
        <div className={styles.slItems}>
          {sessions.map((s) => (
            <div key={s.path} className={styles.slItem} onClick={() => onSelect(s)}>
              <button
                type="button"
                className={styles.slDelete}
                onClick={(e) => handleDelete(e, s)}
                aria-label="삭제"
                title="삭제"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" x2="10" y1="11" y2="17" />
                  <line x1="14" x2="14" y1="11" y2="17" />
                </svg>
              </button>
              <div className={styles.slDate}>
                {s.date} {s.time}
              </div>
              <div className={styles.slTitle}>{s.title}</div>
              <div className={styles.slSteps}>
                {visibleSteps(cli, s.ai_polish).map((step) => (
                  <span
                    key={step.id}
                    className={clsx(styles.slStep, s.steps[step.field] && styles.done)}
                  >
                    {s.steps[step.field] ? "✓" : "·"} {step.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
