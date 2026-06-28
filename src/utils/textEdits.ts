// transcript_text_edits.json 로드/매칭 유틸
//
// LLM(/meeting 스킬)이 transcript_corrected.txt에 적용한 텍스트 교정 로그.
// 한 라인에 여러 edit이 가능하므로 Map의 값이 배열.
//
// 매칭 키 우선순위:
//   1. line (1-based) + new 포함 검증 — 빠른 경로 (정상 흐름)
//   2. time + new 포함 검증 — fallback (사용자 라인 추가/삭제로 line 시프트한 경우)
//   3. 둘 다 실패 — 매칭 안 함 (조용한 누락 — 잘못된 매칭보다 안전)

import { invoke } from "@tauri-apps/api/core";

export interface TextEdit {
  line: number;
  time?: string;
  old: string;
  new: string;
  reason?: string;
  estimated?: boolean;
}

interface MatchableLine {
  time?: string;
  text?: string;
}

/**
 * 세션의 transcript_text_edits.json을 로드.
 * 파일이 없거나 파싱 실패 시 빈 배열 반환.
 */
export async function loadTranscriptTextEdits(sessionPath: string): Promise<TextEdit[]> {
  if (!invoke) return [];
  try {
    const text = await invoke<string>("cmd_read_session_file", {
      sessionPath,
      filename: "transcript_text_edits.json",
    });
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.edits) ? (parsed.edits as TextEdit[]) : [];
  } catch {
    return [];
  }
}

/**
 * 라인 인덱스(0-based) → 그 라인의 TextEdit 배열 매핑.
 * 한 라인에 여러 단어 교정이 있을 수 있어 배열.
 */
export function buildEditsByLine(
  edits: TextEdit[],
  lines: MatchableLine[]
): Map<number, TextEdit[]> {
  const result = new Map<number, TextEdit[]>();

  for (const edit of edits) {
    const matched = findMatchingLineIndex(edit, lines);
    if (matched < 0) continue;
    const arr = result.get(matched) ?? [];
    arr.push(edit);
    result.set(matched, arr);
  }

  return result;
}

function findMatchingLineIndex(edit: TextEdit, lines: MatchableLine[]): number {
  // 1. line 빠른 경로 + new 포함 검증
  const idx = edit.line - 1;
  if (idx >= 0 && idx < lines.length) {
    const line = lines[idx];
    if (line.text && line.text.includes(edit.new)) {
      return idx;
    }
  }

  // 2. time + new fallback
  if (edit.time) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.time === edit.time && line.text && line.text.includes(edit.new)) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * 라인 텍스트를 edit들의 `new` 위치 기준으로 분해해서 segment 배열 반환.
 * - segment.edit이 있으면 교정된 부분 (highlight 대상)
 * - 없으면 일반 텍스트
 *
 * 겹치는 매칭은 첫 매칭만 유지 (간단함 + 실제로 거의 발생 안 함).
 */
export function splitLineByEdits(
  text: string,
  edits: TextEdit[]
): Array<{ text: string; edit?: TextEdit }> {
  if (edits.length === 0) return [{ text }];

  // 각 edit의 new를 라인에서 찾아 위치 기록
  const matches: Array<{ start: number; end: number; edit: TextEdit }> = [];
  for (const edit of edits) {
    const start = text.indexOf(edit.new);
    if (start < 0) continue;
    matches.push({ start, end: start + edit.new.length, edit });
  }

  // 위치 순 정렬 + 겹치는 매칭 제거 (첫 매칭 유지)
  matches.sort((a, b) => a.start - b.start);
  const dedup: typeof matches = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      dedup.push(m);
      lastEnd = m.end;
    }
  }

  // 분해
  const segments: Array<{ text: string; edit?: TextEdit }> = [];
  let cursor = 0;
  for (const m of dedup) {
    if (m.start > cursor) {
      segments.push({ text: text.substring(cursor, m.start) });
    }
    segments.push({ text: text.substring(m.start, m.end), edit: m.edit });
    cursor = m.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.substring(cursor) });
  }
  return segments;
}
