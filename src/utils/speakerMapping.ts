// speaker_mapping.json 관련 공통 유틸
// - load/parse: 이전(문자열 값)/신규(객체 값) 포맷 모두 지원
// - save (merge): 파일 전체를 읽어 해당 speaker만 수정 → 다른 엔트리 보존

import { invoke } from "@tauri-apps/api/core";

import type { SpeakerEntry, SpeakerMapping } from "@/types";

// ── 화자 매칭 상태 (전사본 칩 3상태 시각·triage용) ───────────
// UNKNOWN(세그먼트 라벨)은 별개 개념 — 여기 상태와 무관.
export type SpeakerState = "unset" | "guess" | "confirmed";

/**
 * 엔트리에서 매칭 상태 파생.
 * - unset(미확인): 이름 없음
 * - confirmed(확정): 사용자가 확정함
 * - guess(AI 추정): 이름 있으나 미확정
 */
export function speakerState(entry: SpeakerEntry | undefined | null): SpeakerState {
  if (!entry || !entry.name) return "unset";
  return entry.confirmed ? "confirmed" : "guess";
}

/**
 * 화자 팝오버에 보여줄 reason 텍스트 정리.
 * - raw `SPEAKER_\d+` → "참석자 N" (표시 규칙 일관 + 가독성. 이름이 아닌 번호로 — 미확정 이름을
 *   근거 안에서 단정하는 순환을 피함)
 * - 블록 라벨("AI 추정 근거"/"AI 힌트")과 중복되는 선행 "근거:"·"미확인 —" 접두 제거
 * 줄바꿈(\n)은 보존 — 표시단(CSS pre-wrap)이 절 구분을 살린다.
 */
export function formatReason(reason: string | undefined | null): string {
  if (!reason) return "";
  let t = reason.trim();
  t = t.replace(/^(근거\s*[:：]\s*|미확인\s*[—\-:：]\s*)/u, "");
  t = t.replace(/SPEAKER_(\d+)/g, (_, n) => `참석자 ${parseInt(n, 10)}`);
  return t;
}

/**
 * 표시 화자 목록 기준 triage 집계 — 확정 N명 / 확인 필요(추정+미확인) M명.
 * speakers: 전사본에 실제 등장하는 SPEAKER_XX(UNKNOWN 제외, 호출부에서 거름).
 */
export function countTriage(
  mapping: SpeakerMapping,
  speakers: string[]
): { confirmed: number; needsReview: number } {
  let confirmed = 0;
  let needsReview = 0;
  for (const sp of speakers) {
    if (speakerState(mapping[sp]) === "confirmed") confirmed++;
    else needsReview++;
  }
  return { confirmed, needsReview };
}

/**
 * 세션의 speaker_mapping.json을 읽어 파싱된 매핑 객체를 반환.
 * @param {string} sessionPath
 * @returns {Promise<Record<string, { name: string, reason: string }>>}
 */
export async function loadSpeakerMapping(sessionPath: string): Promise<SpeakerMapping> {
  if (!invoke) return {};
  const raw = await invoke<string>("cmd_read_session_file", {
    sessionPath,
    filename: "speaker_mapping.json",
  }).catch(() => null);
  return parseSpeakerMapping(raw);
}

/**
 * speaker_mapping.json 원본 문자열을 { SPEAKER_XX: { name, reason } } 형태로 파싱.
 */
export function parseSpeakerMapping(raw: string | null | undefined): SpeakerMapping {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    const mapping = data.speaker_mapping || data;
    const result: SpeakerMapping = {};
    for (const [key, val] of Object.entries(mapping)) {
      const v = val as
        | { name?: string; reason?: string; confirmed?: boolean }
        | string
        | null
        | undefined;
      const isObj = typeof v === "object" && v !== null;
      const name = isObj ? v.name || "" : (v as string) || "";
      const reason = isObj ? v.reason || "" : "";
      // confirmed 해석: 명시 값 우선 → 없으면(레거시) 휴리스틱.
      // "UI에서 매칭"은 saveSpeakerMapping이 과거 사용자 직접 매칭 시에만 부여한 reason이라
      // (AI 추정은 자체 근거 reason을 가짐) 사용자 확정으로 안전하게 해석 — 이전 작업 보존.
      const confirmed = isObj && v.confirmed !== undefined ? v.confirmed : reason === "UI에서 매칭";
      result[key] = name ? { name, reason, confirmed } : { name, reason };
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 특정 speaker 엔트리만 병합 저장. 다른 엔트리는 보존.
 * 저장 직전 파일을 다시 읽어 merge (race condition 회피).
 *
 * @param {string} sessionPath
 * @param {string} speaker
 * @param {{ name?: string, reason?: string }} patch
 */
export async function saveSpeakerMapping(
  sessionPath: string,
  speaker: string,
  patch: { name?: string; reason?: string; confirmed?: boolean }
) {
  if (!invoke) throw new Error("Tauri invoke unavailable");

  const raw = await invoke<string>("cmd_read_session_file", {
    sessionPath,
    filename: "speaker_mapping.json",
  }).catch(() => null);

  let data: { speaker_mapping: Record<string, SpeakerEntry | string> } = { speaker_mapping: {} };
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      data = parsed.speaker_mapping ? parsed : { speaker_mapping: parsed };
    } catch {}
  }

  const existing = data.speaker_mapping[speaker];
  const existingObj: SpeakerEntry =
    existing && typeof existing === "object"
      ? existing
      : { name: (existing as string) || "", reason: "" };

  const merged: SpeakerEntry = {
    name: patch.name !== undefined ? patch.name : existingObj.name || "",
    reason: patch.reason !== undefined ? patch.reason : existingObj.reason || "",
  };

  // 매칭 완료 시 reason이 비어있으면 기본값
  if (merged.name && !merged.reason) {
    merged.reason = "UI에서 매칭";
  }

  // confirmed 병합 — patch 명시 우선, 없으면 기존 보존.
  // 값이 정해지면(true/false) 명시 기록 → "확정 취소"가 레거시 "UI에서 매칭" 휴리스틱에
  // 다시 덮어쓰이는 걸 막는다(parse는 confirmed 부재일 때만 휴리스틱 적용). name 없으면(미확인) 미기록.
  const mergedConfirmed = patch.confirmed !== undefined ? patch.confirmed : existingObj.confirmed;
  if (merged.name && mergedConfirmed !== undefined) merged.confirmed = mergedConfirmed;

  data.speaker_mapping[speaker] = merged;

  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: "speaker_mapping.json",
    content: JSON.stringify(data, null, 2),
  });
}
