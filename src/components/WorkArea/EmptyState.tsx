import AssistRequestForm from "@/components/AssistRequestForm";
import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  // 회의록 작성 완료 여부 — 자유 대화 진입 폼 노출 분기.
  notesWritten: boolean;
  // 대화형 추가 요청(/assist) 가능 여부 — mlx(로컬 LLM)는 에이전트가 없어 false.
  assistAvailable?: boolean;
  onRequestAi: (request: string) => void;
}

/**
 * Claude 작업 패널의 빈 상태(PTY 없음) UI. 사용자가 toolbar "✦ AI"로 panel을 명시 열었는데
 * 진행 중인 작업도 없고 PTY도 죽어있을 때 노출. notes_written 여부에 따라:
 *   - 회의록 작성 전: 사이드바로 안내 (panel에서 시작할 일 없음)
 *   - 회의록 작성 후: 요청 입력 폼 (입력 선행 — 사이드바와 동일 핸들러로 전송)
 *   - 로컬 LLM(assistAvailable=false): 추가 요청 불가 안내 (직접 편집 유도)
 */
export default function EmptyState({
  notesWritten,
  assistAvailable = true,
  onRequestAi,
}: EmptyStateProps) {
  if (!assistAvailable) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.icon} aria-hidden="true">
          ✦
        </div>
        <h3 className={styles.title}>AI 도우미</h3>
        <p className={styles.description}>
          로컬 AI는 회의록 작성까지 지원해요.
          <br />
          내용 수정은 [회의록] 탭에서 직접 편집해주세요.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.emptyState}>
      <div className={styles.icon} aria-hidden="true">
        ✦
      </div>
      <h3 className={styles.title}>AI 도우미</h3>
      {notesWritten ? (
        <>
          <p className={styles.description}>
            회의록에 대해 요청할 내용을 적어주세요.
            <br />
            AI가 요청부터 바로 처리해요.
          </p>
          <div className={styles.formWrap}>
            <AssistRequestForm onSubmit={onRequestAi} />
          </div>
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
