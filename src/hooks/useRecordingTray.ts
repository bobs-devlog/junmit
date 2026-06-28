import { useEffect } from "react";
import { Activity } from "@/constants";
import {
  ensureRecordingTray,
  updateRecordingTrayTimer,
  destroyRecordingTray,
} from "@/utils/recordingTray";

// 메뉴바 트레이 라이프사이클 — RecordingScreen에서 분리한 단일 책임(SRP).
// 녹음 중에만 인디케이터 표시(메뉴 없음 — Tauri 2 menu callback listener race 회피),
// 매 회의마다 생성/제거(메뉴바 공간 점유 회피).
export default function useRecordingTray(activity: Activity, elapsed: number): void {
  // 녹음 중에만 표시. Saving은 곧 navigate되므로 언마운트 cleanup에서 정리, 그 외엔 즉시 제거.
  useEffect(() => {
    if (activity === Activity.Recording) {
      void ensureRecordingTray();
    }
    if (activity !== Activity.Recording && activity !== Activity.Saving) {
      void destroyRecordingTray();
    }
  }, [activity]);

  // 트레이 타이틀(타이머) 갱신.
  useEffect(() => {
    if (activity !== Activity.Recording) return;
    void updateRecordingTrayTimer(elapsed);
  }, [activity, elapsed]);

  // 화면 언마운트 시 제거.
  useEffect(() => {
    return () => {
      void destroyRecordingTray();
    };
  }, []);
}
