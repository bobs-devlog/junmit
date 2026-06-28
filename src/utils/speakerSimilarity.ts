// speaker_similarity.json 관련 공통 유틸 (화자 합치기 제안)
// - load: 화자분리가 산출한 합치기 후보쌍 + 사용자가 거절한 쌍(dismissed) 읽기
// - dismiss (merge): 파일 전체를 읽어 dismissed에만 추가 → candidates/threshold 보존
//
// 후보는 pyannote_diarize.py가 화자별 임베딩 쌍별 코사인(≥threshold)으로 산출한다.
// **자동 병합은 어디에서도 하지 않는다** — 후보를 보여주고 사용자가 수락(같은 이름 부여)하거나
// 거절(숨김)할 뿐. 거절은 dismissed에 영속화돼 다시 뜨지 않는다.

import { invoke } from "@tauri-apps/api/core";

import type { SpeakerSimilarity } from "@/types";

const FILENAME = "speaker_similarity.json";

const EMPTY: SpeakerSimilarity = { threshold: 0, candidates: [], dismissed: [] };

/**
 * 쌍 키 — 작은 SPEAKER 번호를 먼저 둬서 (a,b)/(b,a)가 같은 키가 되도록 정규화.
 * dismissed 비교·중복 방지의 단일 형식.
 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/**
 * 세션의 speaker_similarity.json을 읽어 파싱. 파일이 없거나(기존 세션·계산 생략) 깨지면 빈 구조.
 */
export async function loadSpeakerSimilarity(sessionPath: string): Promise<SpeakerSimilarity> {
  if (!invoke) return { ...EMPTY };
  const raw = await invoke<string>("cmd_read_session_file", {
    sessionPath,
    filename: FILENAME,
  }).catch(() => null);
  if (!raw) return { ...EMPTY };
  try {
    const data = JSON.parse(raw);
    return {
      threshold: typeof data.threshold === "number" ? data.threshold : 0,
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      dismissed: Array.isArray(data.dismissed) ? data.dismissed : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 한 후보쌍을 거절(dismissed에 추가) 후 저장. 저장 직전 파일을 다시 읽어 merge (race 회피).
 * candidates/threshold는 그대로 보존하고 dismissed만 갱신한다.
 */
export async function dismissSimilarityPair(sessionPath: string, a: string, b: string) {
  if (!invoke) throw new Error("Tauri invoke unavailable");
  const current = await loadSpeakerSimilarity(sessionPath);
  const key = pairKey(a, b);
  if (current.dismissed.includes(key)) return;
  const next: SpeakerSimilarity = {
    ...current,
    dismissed: [...current.dismissed, key],
  };
  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: FILENAME,
    content: JSON.stringify(next, null, 2),
  });
}
