import clsx from "clsx";
import AudioLevelMeter from "../AudioLevelMeter";
import { activityMeta, Activity } from "@/constants";
import styles from "./Sidebar.module.css";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Props {
  // 녹음 자체 상태 표시용. Saving도 같은 컴포넌트에서 처리되니 활동성 받음.
  activity: Activity; // Recording 또는 Saving
  elapsed: number;
  level: number;
  // 다음 리마인더 트리거 elapsed (초). 처음엔 duration*60, snooze 후엔 갱신됨.
  targetSec: number;
  onStop: () => void;
  onAbort: () => void;
}

// 녹음·저장 화면의 사이드바 콘텐츠. RecordingScreen이 portal로 주입.
// stepper 노출 X (모든 단계 ○ 상태이고 녹음 컨트롤·timer가 사이드바 점유).
export default function RecordingSidebarControls({
  activity,
  elapsed,
  level,
  targetSec,
  onStop,
  onAbort,
}: Props) {
  const meta = activityMeta(activity);
  const remainingSec = Math.max(0, targetSec - elapsed);
  const isRecording = activity === Activity.Recording;

  return (
    <div className={styles.controls}>
      <div className={clsx(styles.status, styles[meta.tone])} data-tone={meta.tone}>
        <span className={styles.statusDot} />
        <span>{meta.label}</span>
      </div>

      {isRecording && (
        <>
          <div className={styles.timer}>{formatTime(elapsed)}</div>
          <div className={clsx(styles.remaining, remainingSec <= 180 && styles.warn)}>
            남은 시간 {formatTime(remainingSec)}
          </div>
          <AudioLevelMeter level={level} />
          <button className="btn btn-primary btn-large recording" onClick={onStop}>
            <span className="btn-icon">⏹</span>녹음 종료
          </button>
        </>
      )}

      {/* Saving 중에는 중단만 — 다만 ffmpeg 변환 중이라 보통 짧음 */}
      {!isRecording && (
        <button className="btn btn-danger" onClick={onAbort}>
          중단
        </button>
      )}
    </div>
  );
}
