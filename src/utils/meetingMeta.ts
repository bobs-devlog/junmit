// 세션 디렉토리의 meeting.json read/write 유틸.

import { invoke } from "@tauri-apps/api/core";
import type { MeetingMeta } from "@/types";

export async function loadMeetingMeta(sessionPath: string): Promise<MeetingMeta | null> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath,
    filename: "meeting.json",
  }).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MeetingMeta;
  } catch {
    return null;
  }
}

export async function saveMeetingMeta(sessionPath: string, meta: MeetingMeta): Promise<void> {
  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: "meeting.json",
    content: JSON.stringify(meta, null, 2),
  });
}

/** meeting.json의 일부 필드만 갱신 (다른 필드는 유지). */
export async function updateMeetingMeta(
  sessionPath: string,
  patch: Partial<MeetingMeta>
): Promise<void> {
  const current = (await loadMeetingMeta(sessionPath)) ?? {
    title: "",
    date: "",
    type: "auto",
    attendees: [],
    agenda: "",
    source: "manual",
  };
  await saveMeetingMeta(sessionPath, { ...current, ...patch });
}
