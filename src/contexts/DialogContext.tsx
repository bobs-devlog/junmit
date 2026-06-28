import { createContext, useContext, useState, useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import Dialog from "@/components/Dialog";
import type { AlertOptions, DialogApi, DialogConfig, ConfirmOptions } from "@/types";

const DialogContext = createContext<DialogApi | null>(null);

interface DialogProviderProps {
  children: ReactNode;
}

/**
 * 전역 모달 Provider. 같은 모달로 결정(confirm)·통지(alert) 둘 다 렌더한다.
 * - confirm(options): Promise<boolean> (확인=true, 취소=false)
 * - alert(options): Promise<void> (단일 버튼, 어떻게 닫든 동일)
 * Tauri WebView는 window.confirm()/alert()를 suppress하므로 이 Provider가 대체 경로.
 */
export function DialogProvider({ children }: DialogProviderProps) {
  const [config, setConfig] = useState<DialogConfig | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions = {}): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // 이미 열려있던 모달이 있으면 이전 Promise를 취소로 마감 (pending 누수 방지)
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setConfig({
        title: options.title ?? "확인",
        body: options.body ?? "",
        confirmLabel: options.confirmLabel ?? "확인",
        cancelLabel: options.cancelLabel ?? "취소",
        danger: options.danger ?? false,
        hideCancel: false,
      });
    });
  }, []);

  const alert = useCallback((options: AlertOptions = {}): Promise<void> => {
    return new Promise<void>((resolve) => {
      resolveRef.current?.(false);
      // 통지는 결과가 없으므로 어떻게 닫혀도(확인/ESC/바깥클릭) 그대로 resolve.
      resolveRef.current = () => resolve();
      setConfig({
        title: options.title ?? "알림",
        body: options.body ?? "",
        confirmLabel: options.confirmLabel ?? "확인",
        cancelLabel: "",
        danger: false,
        hideCancel: true,
      });
    });
  }, []);

  const dismiss = useCallback((ok: boolean) => {
    setConfig(null);
    resolveRef.current?.(ok);
    resolveRef.current = null;
  }, []);

  const value = useMemo<DialogApi>(() => ({ confirm, alert }), [confirm, alert]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Dialog config={config} onDismiss={dismiss} />
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}
