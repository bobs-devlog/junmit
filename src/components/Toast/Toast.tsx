import { useState, useEffect } from "react";
import clsx from "clsx";
import type { ToastData, ToastType } from "@/types";
import styles from "./Toast.module.css";

const DEFAULT_DURATION: Record<ToastType, number> = {
  error: 4000,
  success: 2000,
  info: 3000,
};

const TYPE_CLASS: Record<ToastType, string> = {
  error: styles.toastError,
  success: styles.toastSuccess,
  info: styles.toastInfo,
};

interface ToastProps {
  toast: ToastData | null;
  onDismiss: () => void;
}

export default function Toast({ toast, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const duration = toast.duration ?? DEFAULT_DURATION[toast.type] ?? DEFAULT_DURATION.info;
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300); // fade-out 후 제거
    }, duration);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const handleClick = () => {
    setVisible(false);
    setTimeout(onDismiss, 300);
  };

  return (
    <div
      className={clsx(styles.toast, TYPE_CLASS[toast.type || "info"], visible && styles.visible)}
      onClick={handleClick}
    >
      <span>{toast.message}</span>
    </div>
  );
}
