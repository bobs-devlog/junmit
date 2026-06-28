import clsx from "clsx";
import { buildSpeakerLabels } from "@/utils/meetingNotes";
import type { SpeakerMapping } from "@/types";
import styles from "./SpeakerMappingList.module.css";

interface SpeakerMappingListProps {
  mapping: SpeakerMapping | null;
}

/**
 * 편집 모드에서 SPEAKER_XX 라벨별 표시 라벨을 한눈에 보여주는 목록.
 * 순수 표시 컴포넌트 — 클릭/편집 불가능.
 *
 * 편집 textarea엔 SPEAKER_XX 원본이 그대로 노출되므로, 이 칩이 `SPEAKER_03 → 참석자 3` 범례 역할을
 * 한다(미매핑은 "참석자 N", 매핑되면 이름). 본문 표시 라벨과 같은 buildSpeakerLabels를 써서
 * 회의록 본문에서 보이는 라벨과 일치시킨다.
 *
 * @param {object} mapping — { SPEAKER_XX: { name, reason } } 형태
 */
export default function SpeakerMappingList({ mapping }: SpeakerMappingListProps) {
  if (!mapping) return null;

  // `_` 접두 키(`_quality_warning` 등)는 화자가 아닌 메타 정보라 목록에서 제외.
  const entries = Object.entries(mapping)
    .filter(([k]) => !k.startsWith("_"))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;

  const labels = buildSpeakerLabels(mapping);

  return (
    <div className={styles.speakerMappingList}>
      <span className={styles.speakerMappingListLabel}>화자 매핑</span>
      <div className={styles.speakerMappingListChips}>
        {entries.map(([speaker, info]) => {
          const unassigned = !info?.name;
          // 미매핑은 "참석자 N"(친화 순번), 매핑되면 이름. labels에 없는 키(_메타 등)는 원본 라벨 유지.
          const display = labels[speaker] ?? speaker;
          return (
            <span
              key={speaker}
              className={clsx(styles.speakerChip, unassigned && styles.unassigned)}
            >
              <span className={styles.speakerChipId}>{speaker}</span>
              <span className={styles.speakerChipSep}>→</span>
              <span className={styles.speakerChipName}>{display}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
