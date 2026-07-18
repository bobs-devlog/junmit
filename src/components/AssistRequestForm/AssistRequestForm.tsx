import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import styles from "./AssistRequestForm.module.css";

// 자주 쓰는 요청 예시 — 클릭하면 입력란에 채워져 다듬은 뒤 보낼 수 있다(자동 전송 X —
// 편집 여지 + 오클릭 즉시 실행 방지). 로컬 텍스트 작업만 — MCP 연동(슬랙 발송 등)은
// 인증 상태에 따라 실패할 수 있어 예시로 밀지 않는다.
const EXAMPLE_REQUESTS = [
  "메신저로 공유할 수 있게 짧게 정리해줘",
  "결정사항과 할 일만 뽑아줘",
  "회의록을 더 간결하게 줄여줘",
];

interface AssistRequestFormProps {
  // 요청 텍스트 제출 — 호출자가 SessionContext.requestAi로 전달. 빈 입력은 폼이 걸러 호출 안 됨.
  onSubmit: (request: string) => void;
  // 접을 수 있는 배치(사이드바 버튼 확장형)에서 Esc·취소 버튼 처리. 없으면 취소 UI 미노출.
  onCancel?: () => void;
  autoFocus?: boolean;
}

// "AI에게 추가 요청" 입력 선행 폼 — 사이드바·작업 패널 빈 상태 공용.
// 요청을 먼저 받아 AI 실행에 실어 보내므로(초기 프롬프트/stdin), AI 기동·인사를
// 기다렸다가 터미널에 입력하는 지연이 없다. Enter 제출, Shift+Enter 줄바꿈
// (줄바꿈은 전송 시 requestAi가 한 줄로 정리).
export default function AssistRequestForm({
  onSubmit,
  onCancel,
  autoFocus = false,
}: AssistRequestFormProps) {
  const [request, setRequest] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSubmit = request.trim().length > 0;

  const submit = () => {
    const trimmed = request.trim();
    if (!trimmed) return;
    setRequest("");
    onSubmit(trimmed);
  };

  // 예시 칩 클릭 → 입력란 채우고 focus — Enter로 바로 보내거나 이어서 다듬을 수 있게.
  const fillExample = (example: string) => {
    setRequest(example);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (keyEvent: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 IME 조합 중 Enter는 조합 확정이지 제출이 아니다 — isComposing 가드 필수.
    if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.nativeEvent.isComposing) {
      keyEvent.preventDefault();
      submit();
      return;
    }
    if (keyEvent.key === "Escape" && onCancel) {
      keyEvent.preventDefault();
      onCancel();
    }
  };

  return (
    <div className={styles.form}>
      <textarea
        ref={textareaRef}
        className={styles.input}
        value={request}
        onChange={(changeEvent) => setRequest(changeEvent.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="AI에게 요청할 내용을 입력하세요"
        rows={3}
        autoFocus={autoFocus}
      />
      <div className={styles.examples}>
        {EXAMPLE_REQUESTS.map((example) => (
          <button
            key={example}
            type="button"
            className={styles.exampleChip}
            onClick={() => fillExample(example)}
          >
            {example}
          </button>
        ))}
      </div>
      <div className={styles.actions}>
        {onCancel && (
          <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
            취소
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary btn-small"
          aria-disabled={!canSubmit}
          onClick={submit}
        >
          요청 보내기
        </button>
      </div>
    </div>
  );
}
