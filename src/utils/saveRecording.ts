// 녹음 → 세션 디렉토리 저장 (cmd_create_session + ffmpeg 변환).
// RecordingScreen 정상 흐름과 AppShell의 close_requested 핸들러 둘 다 호출.
//
// 마이크·시스템 오디오 모두 네이티브 캡처가 녹음 중 app_data_dir 스테이징에 직접 기록하므로,
// 여기서는 세션 디렉토리만 만들고 cmd_save_recording(=convert_recording)이 스테이징을 읽어 변환·믹스한다.

import { invoke } from "@tauri-apps/api/core";
import type { Meeting, MeetingNote } from "@/types";

export async function saveRecording(
  meeting: Meeting | null,
  cancelGetter: () => boolean,
  notes: MeetingNote[] = []
): Promise<{ dir: string; captureMode: string } | null> {
  const title = meeting?.title || "회의";
  const attendees = meeting?.attendees || [];
  const dir = await invoke<string>("cmd_create_session", {
    title,
    attendees,
    meetingType: meeting?.meetingType || "auto",
    time: meeting?.time,
    agenda: meeting?.agenda ?? "",
    source: meeting?.source ?? "manual",
    detailedCorrection: meeting?.detailedCorrection ?? true,
  });
  if (cancelGetter()) return null;

  // convert가 실측으로 결정한 캡처 모드("mic"/"mic+system")를 반환 — 사용량 이벤트에 첨부한다.
  const captureMode = await invoke<string>("cmd_save_recording", { sessionDir: dir });
  if (cancelGetter()) return null;

  // 녹음본 저장이 끝난 뒤 메모를 notes.json으로 flush — 더 중요한 녹음본을 먼저 안전하게 보존.
  // 메모가 없으면 파일을 만들지 않아 /meeting 동작이 종전과 동일.
  // notes는 RecordingScreen 로컬 state라 정상 종료 경로에서만 전달됨. AppShell close_requested
  // 비상 저장 경로는 notes에 접근할 수 없어 빈 배열(메모 미포함) — 의도된 한계.
  if (notes.length > 0) {
    await invoke<void>("cmd_write_session_file", {
      sessionPath: dir,
      filename: "notes.json",
      content: JSON.stringify({ notes }, null, 2),
    });
  }

  return { dir, captureMode };
}
