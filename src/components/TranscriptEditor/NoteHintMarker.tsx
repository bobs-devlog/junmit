import { useState } from "react";
import styles from "./NoteHintMarker.module.css";

// 녹음 중 사용자가 남긴 화자 힌트(notes.json kind=speaker)를 앵커 발화 줄의 화자 칩 옆에
// 표시하는 🎙 마커. 호버하면 popover로 누구를 언제 표시했는지 보여줌.
//
// 위치·인터랙션은 SpeakerEditMarker(AI 교정 ⓘ)와 같은 문법 — 줄에 붙는 메타데이터는 칩 옆.
// 색만 중립 슬레이트: amber(AI 교정)와 구분해 출처(사용자 vs AI)를 시각으로 나눈다.
// 힌트는 내용이 이름 하나뿐이라 행으로 세우면 과함 — 마커 흡수로 전사 사이 행 수를 줄인다.

interface NoteHintMarkerProps {
  // 표시한 참석자 이름.
  speaker: string;
  // "M:SS" 표기 시각 (부모가 포맷).
  time: string;
}

export default function NoteHintMarker({ speaker, time }: NoteHintMarkerProps) {
  const [hover, setHover] = useState(false);
  return (
    <span
      className={styles.hintMarker}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className={styles.hintButton} role="img" aria-label={`화자 표시: ${speaker}`}>
        🎙
      </span>
      {hover && (
        <span className={styles.hintPopover} role="tooltip">
          <span className={styles.hintHeader}>
            <span className={styles.hintTitle}>녹음 메모</span>
            <span className={styles.hintLabels}>
              🎙 {speaker} · {time}
            </span>
          </span>
          <span className={styles.hintDesc}>녹음 중에 이 시점의 화자로 직접 표시했어요</span>
        </span>
      )}
    </span>
  );
}
