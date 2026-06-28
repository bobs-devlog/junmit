import { useState } from "react";
import clsx from "clsx";
import styles from "./AttendeeEditor.module.css";

// 허용 문자: 한글, 영문, 숫자, 공백, 대시 (SpeakerPicker와 동일 정책)
const VALID_CHAR_RE = /[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s-]/g;
const MAX_NAME_LENGTH = 40;

/**
 * 참석자 태그(pill) 편집 — 화자 매칭 탭 전용. 접힘/펼침 토글 + 이름 add/remove.
 * 참석자는 인덱스로 식별(동명 안전). 이름은 자유 형식(한글·풀네임 허용).
 *
 * (녹음 전 참석자 선택의 리치 리스트 — 이메일·추정/확정·인라인 편집 — 는 별도 `AttendeeList`)
 */
interface AttendeeEditorProps {
  attendees?: string[];
  onAdd: (name: string) => void;
  onRemove: (index: number) => void;
  // 항상 펼친 상태로 렌더 (접기 토글 숨김) — 이미 펼쳐진 컨테이너(회의 정보 팝오버) 안에서 사용.
  alwaysExpanded?: boolean;
}

export default function AttendeeEditor({
  attendees = [],
  onAdd,
  onRemove,
  alwaysExpanded = false,
}: AttendeeEditorProps) {
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState(false);

  const handleAdd = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (!attendees.includes(trimmed)) {
      onAdd(trimmed);
    }
    setNewName("");
  };

  // 접힘 상태: 헤더(요약 + 편집 버튼)만 (alwaysExpanded면 건너뜀)
  if (!alwaysExpanded && !expanded) {
    return (
      <div className={styles.aeCompactCollapsed}>
        <span className={styles.aeSummary}>참석자 {attendees.length}명</span>
        <button
          className={styles.aeToggleBtn}
          onClick={() => setExpanded(true)}
          title="참석자 편집"
        >
          편집
        </button>
      </div>
    );
  }

  return (
    <div className={clsx(styles.aeEditor, styles.aeEditorCompact)}>
      <div className={styles.aeCompactHeader}>
        <span className={styles.aeSummary}>참석자 {attendees.length}명</span>
        {!alwaysExpanded && (
          <button className={styles.aeToggleBtn} onClick={() => setExpanded(false)} title="접기">
            접기
          </button>
        )}
      </div>

      <div className={styles.aeTags}>
        {attendees.map((name, index) => (
          <span key={index} className={styles.aeTag}>
            {name}
            <button className={styles.aeTagRemove} onClick={() => onRemove(index)} title="삭제">
              ×
            </button>
          </span>
        ))}
        {attendees.length === 0 && <span className={styles.aeEmpty}>참석자 없음</span>}
      </div>

      <div className={styles.aeAddRow}>
        <input
          className={styles.aeInput}
          type="text"
          placeholder="이름 추가 (예: Bobs, 김길동-외주)"
          value={newName}
          onChange={(e) => setNewName(e.target.value.replace(VALID_CHAR_RE, ""))}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          maxLength={MAX_NAME_LENGTH}
        />
        <button
          className="btn btn-secondary btn-small"
          onClick={handleAdd}
          disabled={!newName.trim()}
        >
          추가
        </button>
      </div>
    </div>
  );
}
