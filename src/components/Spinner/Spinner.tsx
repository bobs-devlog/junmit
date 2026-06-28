import clsx from "clsx";
import styles from "./Spinner.module.css";

interface SpinnerProps {
  // 지름(px). 기본 14. 24 이상이면 테두리를 굵게.
  size?: number;
  className?: string;
  // 접근성 — 로딩 의미 전달.
  label?: string;
}

export default function Spinner({ size = 14, className, label = "로딩 중" }: SpinnerProps) {
  const borderWidth = size >= 24 ? 3 : 2;
  return (
    <span
      className={clsx(styles.spinner, className)}
      style={{ width: size, height: size, borderWidth }}
      role="status"
      aria-label={label}
    />
  );
}
