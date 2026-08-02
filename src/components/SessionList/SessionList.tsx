import { useState, useEffect } from "react";
import { useDialog } from "@/contexts/DialogContext";
import { useToast } from "@/contexts/ToastContext";
import { invoke } from "@tauri-apps/api/core";
import useSessionSearch from "@/hooks/useSessionSearch";
import SessionCard from "./SessionCard";
import type { Session } from "@/types";
import styles from "./SessionList.module.css";

interface SessionListProps {
  onSelect: (session: Session) => void;
}

export default function SessionList({ onSelect }: SessionListProps) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const { query, setQuery, results, searching } = useSessionSearch(sessions);
  const { confirm } = useDialog();
  const toast = useToast();

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
        <>
          <div className={styles.slSearch}>
            <span aria-hidden="true">🔎</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목·회의록·전사 검색"
              aria-label="회의 기록 검색"
            />
          </div>

          {searching && results.length === 0 ? (
            <div className="ms-loading">&ldquo;{query.trim()}&rdquo;와 일치하는 회의가 없어요</div>
          ) : (
            <div className={styles.slItems}>
              {results.map((result) => (
                <SessionCard
                  key={result.session.path}
                  result={result}
                  query={searching ? query : ""}
                  onSelect={onSelect}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          {searching && results.length > 0 && (
            <div className={styles.slCount}>
              검색 결과 {results.length}건 · 지우면 전체 목록으로 돌아갑니다
            </div>
          )}
        </>
      )}
    </div>
  );
}
