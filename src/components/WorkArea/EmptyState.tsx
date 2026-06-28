import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  // 회의록 작성 완료 여부 — 자유 대화 진입 버튼 노출 분기.
  notesWritten: boolean;
  onRequestAi: () => void;
}

/**
 * Claude 작업 패널의 빈 상태(PTY 없음) UI. 사용자가 toolbar "✦ AI"로 panel을 명시 열었는데
 * 진행 중인 작업도 없고 PTY도 죽어있을 때 노출. notes_written 여부에 따라:
 *   - 회의록 작성 전: 사이드바로 안내 (panel에서 시작할 일 없음)
 *   - 회의록 작성 후: "AI에게 추가 요청하기" 버튼 (사이드바와 동일 핸들러 호출)
 */
export default function EmptyState({ notesWritten, onRequestAi }: EmptyStateProps) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.icon} aria-hidden="true">
        ✦
      </div>
      <h3 className={styles.title}>AI 도우미</h3>
      {notesWritten ? (
        <>
          <p className={styles.description}>
            회의록에 대해 추가 요청이 있으시면
            <br />
            AI에게 직접 말씀해주세요.
          </p>
          <button type="button" className={styles.actionBtn} onClick={onRequestAi}>
            AI에게 추가 요청하기
          </button>
        </>
      ) : (
        <p className={styles.description}>
          회의록 작성 후에 AI에게 추가 요청을 할 수 있어요.
          <br />
          왼쪽 사이드바에서 다음 단계를 시작하세요.
        </p>
      )}
    </div>
  );
}
