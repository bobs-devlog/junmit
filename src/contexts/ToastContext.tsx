import { createContext, useContext, useState, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import Toast from "@/components/Toast";
import type { ToastApi, ToastData, ToastType } from "@/types";

const ToastContext = createContext<ToastApi | null>(null);

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  // toast: null | { message, type, duration, id }
  const [toast, setToast] = useState<ToastData | null>(null);

  const show = useCallback((message: string, type: ToastType = "info", duration?: number) => {
    if (!message) return;
    setToast({ message, type, duration, id: Date.now() });
  }, []);

  const dismiss = useCallback(() => setToast(null), []);

  // 참조 안정성 유지 — useToast()를 쓰는 컴포넌트의 useCallback deps가 매 렌더마다 invalidate되지 않도록
  const value = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (msg: string, duration?: number) => show(msg, "success", duration),
      error: (msg: string, duration?: number) => show(msg, "error", duration),
      info: (msg: string, duration?: number) => show(msg, "info", duration),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toast toast={toast} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
