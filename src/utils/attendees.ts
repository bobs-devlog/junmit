// meeting.json의 attendees 필드 read/write 래퍼.

import { loadMeetingMeta, updateMeetingMeta } from "./meetingMeta";

export async function loadAttendees(sessionPath: string): Promise<string[]> {
  const meta = await loadMeetingMeta(sessionPath);
  return meta?.attendees ?? [];
}

export async function saveAttendees(sessionPath: string, attendees: string[]): Promise<void> {
  await updateMeetingMeta(sessionPath, { attendees });
}
