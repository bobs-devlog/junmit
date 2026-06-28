// 전사 품질 향상용 용어 사전 read/write + 일괄 입력 파싱.
//
// whisper `--prompt` priming과 후보정 LLM 교정이 함께 읽는다. 사용자가 앱에서 편집하는
// 단일 진실 원천(~/Library/Application Support/app.junmit/vocabulary.json, { "terms": [...] }).
// 객체 래퍼를 쓰는 이유: 추후 오인식 힌트 등 형제 필드를 무중단 확장하기 위함.

import { invoke } from "@tauri-apps/api/core";

export interface Vocabulary {
  terms: string[];
}

// 용어는 자유 형식(영문·한글·"AB 테스트"·"CI/CD" 등) — 공격적 문자 필터 없이 길이만 캡.
export const MAX_TERM_LENGTH = 60;

export async function loadVocabulary(): Promise<string[]> {
  try {
    const v = await invoke<Vocabulary>("cmd_read_vocabulary");
    return v?.terms ?? [];
  } catch {
    return [];
  }
}

export async function saveVocabulary(terms: string[]): Promise<void> {
  await invoke<void>("cmd_write_vocabulary", { vocab: { terms } });
}

/**
 * 일괄 붙여넣기 텍스트 → 용어 배열. 줄바꿈·쉼표로 분리, trim, 길이 캡, 대소문자 무시 중복 제거.
 */
export function parseBulkTerms(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\n,]/)) {
    const t = piece.trim();
    if (!t) continue;
    const capped = t.slice(0, MAX_TERM_LENGTH);
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
  }
  return out;
}

/** 기존 목록에 새 용어 병합 — 기존 순서 유지 + 신규만 append (대소문자 무시 중복 제거). */
export function mergeTerms(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const merged = [...existing];
  for (const t of incoming) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  return merged;
}
