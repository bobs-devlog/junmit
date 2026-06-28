import clsx from "clsx";
import styles from "./AudioLevelMeter.module.css";

const BARS = 20;
const MID_THRESHOLD = BARS * 0.6;
const HIGH_THRESHOLD = BARS * 0.85;

function levelClass(i: number, active: number): string | null {
  if (i >= active) return null;
  if (i < MID_THRESHOLD) return styles.low;
  if (i < HIGH_THRESHOLD) return styles.mid;
  return styles.high;
}

interface AudioLevelMeterProps {
  level: number;
}

export default function AudioLevelMeter({ level }: AudioLevelMeterProps) {
  const activeBars = Math.round(level * BARS);

  return (
    <div className={styles.levelMeter}>
      {Array.from({ length: BARS }, (_, i) => (
        <div
          key={i}
          className={clsx(
            styles.levelBar,
            i < activeBars && styles.active,
            levelClass(i, activeBars)
          )}
        />
      ))}
    </div>
  );
}
