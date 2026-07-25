import clsx from "clsx";
import type { SpeakerPerson } from "@/utils/speakerDb";
import styles from "./SpeakerProfileManager.module.css";

/**
 * 화자 사전 화면 본문 (presentational, 상태·영속화는 SpeakerProfileScreen 소유).
 *
 * 전사본에서 화자를 확정할 때마다 그 목소리가 여기 쌓이고, 다음 회의의 화자분리가
 * 읽어 이름을 자동 추정한다. 생체정보 성격이라 삭제·비활성화 수단을 UI로 제공한다.
 * 토글 OFF는 "새 수집·인식 중단"이지 삭제가 아니므로 목록은 그대로 표시한다.
 */
interface SpeakerProfileManagerProps {
  people: SpeakerPerson[];
  enabled: boolean;
  loading: boolean;
  onToggle: (on: boolean) => void;
  onRemovePerson: (name: string) => void;
  onRemoveAll: () => void;
}

/** 인물의 가장 최근 샘플(등록순 마지막)로 "최근 회의" 표기를 만든다. */
function latestMeetingLabel(person: SpeakerPerson): string {
  const latest = person.samples[person.samples.length - 1];
  if (!latest) return "";
  const title = latest.title || "제목 없는 회의";
  return latest.date ? `${title} (${latest.date})` : title;
}

export default function SpeakerProfileManager({
  people,
  enabled,
  loading,
  onToggle,
  onRemovePerson,
  onRemoveAll,
}: SpeakerProfileManagerProps) {
  return (
    <div className={styles.spmRoot}>
      <div className={styles.spmHeader}>
        <p className={styles.spmDescription}>
          전사본에서 화자를 확정하면 그분의 목소리를 기억해, 다음 회의에서 이름을 자동으로
          추정합니다. 모든 음성 데이터는 이 Mac에만 저장됩니다.
        </p>

        <div className={styles.spmToggleRow}>
          <div className={styles.spmToggleMeta}>
            <span className={styles.spmToggleLabel}>화자 자동 인식</span>
            <span className={styles.spmToggleDesc}>
              끄면 새 회의에서 목소리 수집과 이름 추정을 모두 멈춥니다. 기억해 둔 목소리는 지워지지
              않아요.
            </span>
          </div>
          <button
            type="button"
            className={clsx(styles.spmSwitch, enabled && styles.active)}
            role="switch"
            aria-checked={enabled}
            aria-label="화자 자동 인식"
            onClick={() => onToggle(!enabled)}
          >
            <span className={styles.spmSwitchKnob} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className={styles.spmList}>
        {loading ? null : people.length === 0 ? (
          <p className={styles.spmEmpty}>
            아직 등록된 화자가 없어요. 회의 전사본에서 화자를 확정하면 자동으로 등록됩니다.
          </p>
        ) : (
          people.map((person) => (
            <div key={person.name} className={styles.spmRow}>
              <div className={styles.spmRowMeta}>
                <span className={styles.spmName}>{person.name}</span>
                <span className={styles.spmDetail}>
                  목소리 샘플 {person.samples.length}개 · 최근: {latestMeetingLabel(person)}
                </span>
              </div>
              <button
                type="button"
                className={styles.spmRemove}
                onClick={() => onRemovePerson(person.name)}
                aria-label={`화자 사전에서 ${person.name} 삭제`}
              >
                삭제
              </button>
            </div>
          ))
        )}
      </div>

      {people.length > 0 && (
        <div className={styles.spmFooter}>
          <button type="button" className={styles.spmRemoveAll} onClick={onRemoveAll}>
            전체 삭제
          </button>
        </div>
      )}
    </div>
  );
}
