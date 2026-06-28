// transcript_speaker_edits.json 로드/매칭 유틸
//
// LLM(/meeting 스킬)이 자동 화자분리 결과(SPEAKER_XX)를 문맥 기반으로 재할당한
// 로그. 매칭 키 우선순위:
//   1. line (1-based) + time + new_label 검증 — 빠른 경로 (신규 형식)
//   2. time + new_label 검색 — fallback. line 시프트나 옛 형식(line 없음)
//   3. 둘 다 실패 — 매칭 안 함 (조용한 누락 — 잘못된 매칭보다 안전)
//
// 왜 text는 매칭 키에서 뺐나:
// LLM이 edits.json에 적는 text는 transcript_corrected.txt의 실제 텍스트와 미묘하게
// 어긋날 수 있음 (LLM이 의역하거나 작성 시점이 다를 수 있음). 반면 new_label은
// sidecar 적용 후 corrected.txt에 그대로 박혀 있어 매칭 키로 안정적. text는 표시용으로만.

import { invoke } from "@tauri-apps/api/core";

export interface SpeakerEdit {
  line?: number; // 1-based 라인 번호. 신규 형식. 옛 세션은 없을 수 있음
  time: string; // "M:SS"
  text: string; // 라인 본문 일부 인용 (UI 표시용 — 매칭에는 사용 안 함)
  original_label: string;
  new_label: string;
  reason?: string;
}

interface MatchableLine {
  time?: string;
  speaker?: string; // line의 SPEAKER (sidecar 적용 후라 edit.new_label과 일치해야 함)
}

/**
 * 세션의 transcript_speaker_edits.json을 로드.
 * 파일이 없거나 파싱 실패 시 빈 배열 반환.
 */
export async function loadTranscriptSpeakerEdits(sessionPath: string): Promise<SpeakerEdit[]> {
  if (!invoke) return [];
  try {
    const text = await invoke<string>("cmd_read_session_file", {
      sessionPath,
      filename: "transcript_speaker_edits.json",
    });
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.edits) ? (parsed.edits as SpeakerEdit[]) : [];
  } catch {
    return [];
  }
}

/**
 * 라인 인덱스(0-based) → SpeakerEdit 매핑을 미리 계산.
 *
 * @param edits 로드된 edit 배열
 * @param lines 파싱된 라인 배열 (각 line의 time/speaker로 매칭)
 * @returns Map<lineIndex, SpeakerEdit>. 같은 라인에 중복 매칭은 첫 매칭 유지.
 */
export function buildEditsByLine(
  edits: SpeakerEdit[],
  lines: MatchableLine[]
): Map<number, SpeakerEdit> {
  const result = new Map<number, SpeakerEdit>();

  for (const edit of edits) {
    const matched = findMatchingLineIndex(edit, lines);
    if (matched >= 0 && !result.has(matched)) {
      result.set(matched, edit);
    }
  }

  return result;
}

/**
 * 한 SpeakerEdit이 매칭되는 라인 인덱스(0-based)를 찾음.
 *
 * 1. line 인덱스로 시도 + time + new_label 검증 (있으면 빠른 경로)
 * 2. time + new_label로 fallback 검색
 * 3. 못 찾으면 -1
 */
function findMatchingLineIndex(edit: SpeakerEdit, lines: MatchableLine[]): number {
  // 1. line 빠른 경로
  if (typeof edit.line === "number") {
    const idx = edit.line - 1;
    if (idx >= 0 && idx < lines.length) {
      const line = lines[idx];
      if (line.time === edit.time && line.speaker === edit.new_label) {
        return idx;
      }
    }
  }

  // 2. time + new_label fallback (옛 형식 또는 line 시프트 케이스)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.time === edit.time && line.speaker === edit.new_label) {
      return i;
    }
  }

  return -1;
}
