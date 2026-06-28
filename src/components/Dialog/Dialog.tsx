import { useEffect } from "react";
import clsx from "clsx";
import type { DialogConfig } from "@/types";
import styles from "./Dialog.module.css";

interface DialogProps {
  config: DialogConfig | null;
  onDismiss: (ok: boolean) => void;
}

export default function Dialog({ config, onDismiss }: DialogProps) {
  // ESC·바깥 클릭으로 닫기 (confirm은 취소로 처리, alert는 결과 없음)
  useEffect(() => {
    if (!config) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [config, onDismiss]);

  if (!config) return null;

  return (
    <div className="dialog-overlay" onClick={() => onDismiss(false)}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <h2 className={clsx("dialog-title", config.danger && styles.dialogTitleDanger)}>
          {config.title}
        </h2>
        {config.body && <div className="dialog-body">{config.body}</div>}
        <div className={styles.dialogActions}>
          {!config.hideCancel && (
            <button
              className={clsx(styles.dialogBtn, styles.dialogCancel)}
              onClick={() => onDismiss(false)}
            >
              {config.cancelLabel}
            </button>
          )}
          <button
            className={clsx(
              styles.dialogBtn,
              config.danger ? styles.dialogDanger : styles.dialogPrimary
            )}
            onClick={() => onDismiss(true)}
            autoFocus
          >
            {config.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
