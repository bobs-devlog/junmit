import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import useRecorder from "@/hooks/useRecorder";
import type { Recorder } from "@/types";

// recorder 인스턴스를 모든 화면에서 공유 — start(Home)와 stop(Session) 등 화면 간 공유 필요.
const RecorderContext = createContext<Recorder | null>(null);

export function RecorderProvider({ children }: { children: ReactNode }) {
  const recorder = useRecorder();
  return <RecorderContext.Provider value={recorder}>{children}</RecorderContext.Provider>;
}

export function useRecorderContext(): Recorder {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorderContext must be used within RecorderProvider");
  return ctx;
}
