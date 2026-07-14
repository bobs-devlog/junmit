// 세션 디렉토리의 notes.json(녹음 중 메모) read + 전사 줄 배치 계산 유틸.
// 쓰기는 녹음 종료 시 saveRecording이 단 한 번 수행하므로 여기엔 read만 둔다.

import { invoke } from "@tauri-apps/api/core";
import type { MeetingNote } from "@/types";
import { timestampToSec } from "@/utils/transcript";

/** notes.json 로드 — 형태가 온전한 항목만 반환 (파일 없음·파싱 실패·깨진 항목은 조용히 제외). */
export async function loadRecordingNotes(sessionPath: string): Promise<MeetingNote[]> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath,
    filename: "notes.json",
  }).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { notes?: unknown[] };
    if (!Array.isArray(parsed.notes)) return [];
    // 요소 형태 검증 — 손으로 고친 파일의 깨진 항목(t 누락·타입 오류)이 "NaN:NaN" 표기나
    // 오배치(앵커 비교 전부 false)로 번지지 않게 온전한 항목만 통과시킨다.
    return parsed.notes.filter((n): n is MeetingNote => {
      if (!n || typeof n !== "object") return false;
      const note = n as Partial<MeetingNote>;
      if (typeof note.t !== "number" || !Number.isFinite(note.t)) return false;
      if (note.kind === "text") return typeof note.text === "string";
      if (note.kind === "speaker") return typeof note.speaker === "string";
      return false;
    });
  } catch {
    return [];
  }
}

// 전사 줄의 최소 구조 — TranscriptEditor의 Line과 구조적으로 호환(발화 줄만 time 보유).
export interface PlacementLine {
  type: string;
  time?: string;
}

export interface PlacedNote {
  note: MeetingNote;
  // notes 배열에서의 원본 인덱스 — "메모 N" 칩 순회 시 DOM 행을 찾는 data-note-index 키.
  noteIndex: number;
}

export interface NotePlacement {
  // 화자 힌트(kind=speaker) → 앵커 발화 줄 인덱스. 칩 옆 🎙 마커로 표시.
  markersByLine: Map<number, PlacedNote[]>;
  // 자유 메모(kind=text) → 앵커 발화 줄 인덱스(-1 = 첫 발화 이전, 본문 최상단).
  rowsByLine: Map<number, PlacedNote[]>;
}

// 발화 줄 시간 인덱스 항목 — idx는 lines 배열 인덱스, sec은 줄 시작 초.
interface SpeechRef {
  idx: number;
  sec: number;
}

// sec < t인(탭보다 먼저 시작한) 마지막 speech 항목의 배열 인덱스 (없으면 -1) — 이진 탐색.
function lastStartedBefore(speech: SpeechRef[], t: number): number {
  let lo = 0;
  let hi = speech.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (speech[mid].sec < t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * 녹음 메모의 전사 줄 배치 계산 — 앵커는 "탭보다 먼저 시작한(sec < t) 마지막 발화 줄".
 *
 * 같은 초에 시작한 줄을 제외하는(< 이지 <=가 아닌) 이유가 반응 지연 보정의 전부다:
 * 사람이 "누가 말하는지 인지 → 탭"에 1초 이상 걸리므로, 탭과 같은 초에 막 시작한 세그먼트는
 * 인지 대상일 수 없고 직전 세그먼트가 의도된 대상이다(실측: t=17 탭이 0:17 시작 줄이 아니라
 * 0:10의 자기소개 발화를 가리켰음). 그 이상의 보정(지배 화자 윈도우 등)은 시도했다 회귀 —
 * "탭 직전 세그먼트에 붙는다"는 사용자가 예측 가능한 규칙이고, 로컬 파이프라인 hints_mapping의
 * [t-10,t+2] 윈도우는 이름→라벨 매핑용 집계라 위치 표시와 목적이 다르다(매핑은 그쪽이 계속 담당).
 *
 * 화자 힌트(speaker)는 앵커 줄의 칩 옆 마커로 흡수한다(내용이 이름 하나라 행은 과함).
 * 첫 발화 이전 힌트는 첫 발화 줄로 forward-anchor(곧 말할 사람 표시라 의미도 정확),
 * 발화 줄 0개면(정상 파이프라인엔 없는 상태) 생략 — 덕분에 행 렌더에 kind 분기가 없다.
 * 자유 메모(text)는 앵커 줄 뒤 행으로, 첫 발화 이전이면 -1(본문 최상단)에 배치한다.
 *
 * 메모를 lines 배열에 삽입하지 않고 별도 맵으로 두는 이유: 줄 인덱스 = 파일 라인 번호
 * 가정 위에 줄 선택 재할당·검증 영수증 L{n} 포커스·교정 마커 매핑이 서 있기 때문.
 * 렌더 루프가 줄마다 조회하므로 여기서 미리 갈라 줄당 비용을 Map.get 1회로 만든다.
 */
export function buildNotePlacement(notes: MeetingNote[], lines: PlacementLine[]): NotePlacement {
  const markersByLine = new Map<number, PlacedNote[]>();
  const rowsByLine = new Map<number, PlacedNote[]>();
  if (notes.length === 0) return { markersByLine, rowsByLine };
  const speech: SpeechRef[] = [];
  lines.forEach((l, i) => {
    if (l.type !== "speech" || l.time == null) return;
    const s = timestampToSec(l.time);
    if (s != null) speech.push({ idx: i, sec: s });
  });
  for (const [noteIndex, note] of notes.entries()) {
    const found = lastStartedBefore(speech, note.t);
    let map: Map<number, PlacedNote[]>;
    let anchor: number;
    if (note.kind === "speaker") {
      if (speech.length === 0) continue;
      map = markersByLine;
      anchor = (found === -1 ? speech[0] : speech[found]).idx;
    } else {
      map = rowsByLine;
      anchor = found === -1 ? -1 : speech[found].idx;
    }
    const arr = map.get(anchor);
    if (arr) arr.push({ note, noteIndex });
    else map.set(anchor, [{ note, noteIndex }]);
  }
  return { markersByLine, rowsByLine };
}
