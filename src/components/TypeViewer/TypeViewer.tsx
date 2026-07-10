import type { ReactNode } from "react";
import NotesMarkdownView from "@/components/NotesMarkdownView";
import { extractExampleSection } from "@/utils/meetingTypes";
import { fallbackSpeakerLabels } from "@/utils/speakerMapping";
import styles from "@/screens/MeetingTypes.module.css";

interface TypeViewerProps {
  /** 유형 가이드 원문(.md). */
  content: string;
  /** true=가이드 원문(raw), false=예시 회의록(렌더). */
  full: boolean;
  onSetFull: (full: boolean) => void;
  /** 컨트롤 행 우측에 둘 액션 (직접 편집 / 저장·취소 등). */
  actions?: ReactNode;
}

// 유형 가이드 뷰어 — [예시 회의록 | 가이드] 세그먼트 토글 + 내용. 목록 상세·생성/조정 미리보기 공유.
// 예시 섹션이 없으면 가이드만 표시(토글 숨김).
export default function TypeViewer({ content, full, onSetFull, actions }: TypeViewerProps) {
  const example = extractExampleSection(content);
  const showGuide = full || example == null;

  return (
    <div className={styles.mtViewer}>
      <div className={styles.mtViewerControls}>
        <div className={styles.mtViewTabs} role="tablist">
          {example != null && (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={!showGuide}
                className={!showGuide ? styles.mtTabActive : styles.mtTab}
                onClick={() => onSetFull(false)}
              >
                예시 회의록
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={showGuide}
                className={showGuide ? styles.mtTabActive : styles.mtTab}
                onClick={() => onSetFull(true)}
              >
                가이드
              </button>
            </>
          )}
        </div>
        {actions}
      </div>
      {showGuide ? (
        <pre className={styles.mtRaw}>{content}</pre>
      ) : (
        <div className={styles.mtRendered}>
          <NotesMarkdownView markdown={fallbackSpeakerLabels(example as string)} />
        </div>
      )}
    </div>
  );
}
