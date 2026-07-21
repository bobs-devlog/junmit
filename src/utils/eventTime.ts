// 캘린더 이벤트 time("HH:MM-HH:MM") 파싱·정렬·현재-시각 판정 유틸 (MeetingSelector 전용).
// 백엔드는 오늘 하루치 이벤트만 주고 구조화된 시각 필드가 없어(정렬도 미보장) 이 문자열이 유일한 근거.
// 자정 wrap(end<start → +24h) 규칙은 Rust parse_duration_min(session.rs)과 동일하게 유지할 것.

export interface EventTimeRange {
  /** 자정 기준 분 (0..1439) */
  startMin: number;
  /** startMin보다 항상 큼 — 자정 wrap 시 +1440 보정으로 1440을 넘을 수 있다 */
  endMin: number;
}

/** 자동 선택 후보로 인정하는 "시작 전 여유" — 이 분 안에 시작하는 일정도 지금 녹음 대상으로 본다. */
export const AUTO_SELECT_LEAD_MIN = 10;

const TIME_RANGE_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

/** "HH:MM-HH:MM" 파싱. 형식 불일치·범위 밖이면 null, end<start면 자정 wrap으로 +24h. */
export function parseEventTime(time: string | undefined): EventTimeRange | null {
  if (!time) return null;
  const m = TIME_RANGE_RE.exec(time.trim());
  if (!m) return null;
  const [sh, sm, eh, em] = [m[1], m[2], m[3], m[4]].map(Number);
  if (sh > 23 || sm > 59 || eh > 23 || em > 59) return null;
  const startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  if (endMin < startMin) endMin += 24 * 60;
  return { startMin, endMin };
}

/** 현재 시각을 자정 기준 분으로. now 인자는 수동 검증용(기본 현재). */
export function nowMinutes(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** 시작 시각 오름차순 새 배열. 파싱 불가는 맨 뒤(stable sort라 원 순서 유지). */
export function sortEventsByStartTime<T extends { time?: string }>(events: T[]): T[] {
  const startOf = (e: T) => parseEventTime(e.time)?.startMin ?? Number.MAX_SAFE_INTEGER;
  return [...events].sort((a, b) => startOf(a) - startOf(b));
}

/**
 * 자동 선택할 이벤트 인덱스 — "진행 중이거나 AUTO_SELECT_LEAD_MIN분 내 시작" 후보 중
 * 시작이 가장 늦은 것. 겹칠 때 방금(또는 곧) 시작한 회의가 사용자가 지금 녹음하려는
 * 회의일 확률이 높다는 휴리스틱. 후보 없으면 null(추측 선택 안 함).
 */
export function findAutoSelectIndex<T extends { time?: string }>(
  events: T[],
  nowMin: number
): number | null {
  let best: number | null = null;
  let bestStart = -1;
  events.forEach((event, index) => {
    const range = parseEventTime(event.time);
    if (!range) return;
    const isCandidate = range.startMin <= nowMin + AUTO_SELECT_LEAD_MIN && nowMin < range.endMin;
    if (isCandidate && range.startMin > bestStart) {
      best = index;
      bestStart = range.startMin;
    }
  });
  return best;
}

/** 종료 시각이 지났는지 — 흐림 표시용. 파싱 불가는 false, 자정 wrap 이벤트는 아직 안 끝난 것이므로 false. */
export function isPastEvent(time: string | undefined, nowMin: number): boolean {
  const range = parseEventTime(time);
  return range !== null && range.endMin <= nowMin;
}
