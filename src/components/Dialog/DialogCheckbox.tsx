import { useState } from "react";
import styles from "./Dialog.module.css";

interface Props {
  label: string;
  description?: string;
  defaultChecked?: boolean;
  onChange: (checked: boolean) => void;
}

// 다이얼로그 본문에 넣는 선택지 — 열릴 때마다 새로 mount되므로 defaultChecked가 매번 복원된다.
export default function DialogCheckbox({
  label,
  description,
  defaultChecked = true,
  onChange,
}: Props) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <label className={styles.dialogCheckbox}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <span>
        <span className={styles.dialogCheckboxLabel}>{label}</span>
        {description && <span className={styles.dialogCheckboxDesc}>{description}</span>}
      </span>
    </label>
  );
}
