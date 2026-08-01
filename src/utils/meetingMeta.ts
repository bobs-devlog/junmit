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

/** meeting.json의 일부 필드만 갱신 (다른 필드는 유지).
 *  파일이 손상돼 파싱 불가하면 기본값으로 덮지 않고 throw한다 — 그대로 저장하면 patch에 없던
 *  제목·참석자·유형이 통째로 리셋돼 복구 불가하기 때문. "파일 없음"(신규)만 기본값으로 생성한다. */
export async function updateMeetingMeta(
  sessionPath: string,
  patch: Partial<MeetingMeta>
): Promise<void> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath,
    filename: "meeting.json",
  }).catch(() => null);

  let current: MeetingMeta;
  if (raw == null) {
    current = {
      title: "",
      date: "",
      type: "auto",
      attendees: [],
      agenda: "",
      source: "manual",
    };
  } else {
    try {
      current = JSON.parse(raw) as MeetingMeta;
    } catch {
      throw new Error("meeting.json이 손상되어 갱신을 중단했습니다");
    }
  }
  await saveMeetingMeta(sessionPath, { ...current, ...patch });
}
