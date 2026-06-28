import { useState } from "react";
import SpeakerMappingList from "../SpeakerMappingList";
import type { SpeakerMapping } from "@/types";
import styles from "./NotesEditor.module.css";

interface NotesEditorProps {
  initialContent: string | null;
  mapping: SpeakerMapping | null;
  onSave: (content: string) => void;
  onCancel: () => void;
}

// 편집 모드 화자 라벨 안내를 한 번 닫으면 다시 띄우지 않기 위한 localStorage 키.
// (TerminalWorkspace의 `app.workArea.panelWidth`와 같은 `app.{영역}.{속성}` 네이밍)
const SPEAKER_HINT_DISMISSED_KEY = "app.notesEditor.speakerHintDismissed";

/**
 * 회의록 편집 UI + 액션 바.
 * 자체 editBuffer state 소유 — 편집 중 내용은 이 컴포넌트 안에서만 관리.
 * 저장/취소는 콜백으로 부모에 위임.
 *
 * Phase 2에서 textarea → CodeMirror로 교체 시 이 파일만 수정.
 */
export default function NotesEditor({
  initialContent,
  mapping,
  onSave,
  onCancel,
}: NotesEditorProps) {
  const [buffer, setBuffer] = useState(initialContent || "");
  // 편집 모드에선 본문에 SPEAKER_XX 원본이 그대로 보인다(저장·발행 안정 식별자).
  // 저장하면 화면에선 "참석자 N"/이름으로 치환돼 보인다는 걸 안내. 한 번 닫으면 영구 숨김.
  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem(SPEAKER_HINT_DISMISSED_KEY) === "1"
  );
  const dismissHint = () => {
    setHintDismissed(true);
    localStorage.setItem(SPEAKER_HINT_DISMISSED_KEY, "1");
  };

  return (
    <>
      <div className="notes-pane-actions">
        <button className="sv-action-btn" onClick={() => onSave(buffer)}>
          💾 저장
        </button>
        <button className="sv-action-btn" onClick={onCancel}>
          취소
        </button>
      </div>

      {!hintDismissed && (
        <div className={styles.speakerHint}>
          <span className={styles.speakerHintText}>
            💡 편집 중에는 화자가 <code>SPEAKER_03</code>처럼 보이지만, 저장하면 실제 화면에선{" "}
            <strong>참석자 3</strong>이나 매핑한 이름으로 자동 표시됩니다. 라벨은 그대로 두고 내용만
            수정하세요.
          </span>
          <button
            className={styles.speakerHintClose}
            onClick={dismissHint}
            aria-label="안내 닫기"
            title="다시 보지 않기"
          >
            ✕
          </button>
        </div>
      )}

      <SpeakerMappingList mapping={mapping} />

      <div className="notes-pane-body">
        <textarea
          className={styles.notesTextarea}
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          spellCheck={false}
          placeholder="회의록 원본 (SPEAKER_XX 라벨 유지 필수)"
        />
      </div>
    </>
  );
}
