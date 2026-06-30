import { useState } from "react";
import type { SpeakerEdit } from "@/utils/transcriptEdits";
import styles from "./SpeakerEditMarker.module.css";

// LLM이 화자 라벨을 재할당한 라인 옆에 표시되는 ⓘ 아이콘.
// 호버하면 popover로 변경 종류(original → new)와 reason을 보여줌.
//
// 위치: SpeakerLabel 바로 옆 (라인 시작 영역) — 화자 변경 정보가 그 화자 가까이 있게.
// 인터랙션: 호버 (텍스트 교정 인라인 highlight와 일관)

interface SpeakerEditMarkerProps {
  edit: SpeakerEdit;
}

export default function SpeakerEditMarker({ edit }: SpeakerEditMarkerProps) {
  const [hover, setHover] = useState(false);
  return (
    <span
      className={styles.editMarker}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className={styles.editButton} aria-label="AI 화자 교정">
        ⓘ
      </span>
      {hover && (
        <span className={styles.editPopover} role="tooltip">
          <span className={styles.editHeader}>
            <span className={styles.editTitle}>AI 교정</span>
            <span className={styles.editLabels}>
              <span className={styles.editLabelFrom}>{edit.original_label}</span>
              <span className={styles.editLabelArrow}>→</span>
              <span className={styles.editLabelTo}>{edit.new_label}</span>
            </span>
          </span>
          {edit.reason && <span className={styles.editReason}>{edit.reason}</span>}
        </span>
      )}
    </span>
  );
}
