// meeting-notes 관련 유틸 (단일 파일 구조)
//
// - meeting-notes.md: SPEAKER_XX 라벨이 그대로 포함된 **소스 파일**
//   LLM과 사용자가 직접 편집하는 유일한 마크다운 파일.
//   파일에 저장될 때는 SPEAKER_XX 라벨이 유지됨.
// - 사용자가 보는 "이름이 치환된 뷰"는 파일로 저장되지 않고 **표시 시점에만 substituteNames로 렌더링**.
// - speaker_mapping.json: 화자 → 이름 매핑의 단일 진실 원천.

import { invoke } from "@tauri-apps/api/core";
import { fallbackSpeakerLabels } from "@/utils/speakerMapping";

import type { SpeakerMapping } from "@/types";

const NOTES_FILE = "meeting-notes.md";

// ─── 파일 I/O ───────────────────────────────────────────

export async function loadMeetingNotesMd(sessionPath: string): Promise<string | null> {
  if (!invoke) return null;
  return await invoke<string>("cmd_read_session_file", {
    sessionPath,
    filename: NOTES_FILE,
  }).catch(() => null);
}

export async function saveMeetingNotesMd(sessionPath: string, content: string) {
  if (!invoke) throw new Error("Tauri invoke unavailable");
  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: NOTES_FILE,
    content,
  });
}

/**
 * 주어진 내용을 타임스탬프 백업(meeting-notes.bak.{ts}.md)으로 저장.
 * 편집 저장 시 디스크가 편집 시작 시점과 달라졌을 때(그 사이 AI가 씀) 그 버전을 보존하는 용도.
 * 파일명은 assist "대규모 수정 전 백업"과 같은 규약 — 스킬의 재작성 감지 glob과도 호환.
 */
export async function backupMeetingNotesMd(sessionPath: string, content: string) {
  if (!invoke) throw new Error("Tauri invoke unavailable");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: `meeting-notes.bak.${ts}.md`,
    content,
  });
}

// ─── 표시 라벨 ──────────────────────────────────────────

const SPEAKER_KEY_RE = /^SPEAKER_\d+$/;

function speakerNum(key: string): number {
  return parseInt(key.slice("SPEAKER_".length), 10);
}

/**
 * SPEAKER_XX → **친화 표시 라벨** 매핑. 매핑된 화자는 실제 `name`, 미매핑(빈 이름)은 **"참석자 N"**.
 * N은 SPEAKER_XX의 숫자를 그대로 쓴다(SPEAKER_03 → "참석자 3").
 *
 * SPEAKER 라벨이 0부터 연속(SPEAKER_00, 01, 02…)이라는 실측에 기반해 번호를 직결한다. 덕분에
 * raw 라벨(SPEAKER_03)과 친화 라벨(참석자 3)의 숫자가 일치해 병기 시 어긋남이 없고, 매핑 상태와
 * 무관하게 번호가 고정된다. ("참석자 0"이 첫 화자 — SPEAKER도 0-base라 병기하면 일관)
 *
 * 본문 치환·전사 라벨·회의록 표시처럼 "이름이 있으면 이름"을 보여줄 곳에서 쓴다.
 * `_` 접두 메타 키(`_quality_warning` 등)·`SPEAKER_\d+` 비매칭 키는 제외한다.
 *
 * ⚠️ **동등성 유지**: sidecar `swift-cli/diarize/Sources/Speakers/SpeakerMap.swift`의 라벨 계산과
 * 동일 로직(SPEAKER_\d+만·빈 이름 → "참석자 {숫자}")을 유지해야 합니다.
 * 한 쪽 변경 시 다른 쪽도 함께 갱신하세요.
 */
export function buildSpeakerLabels(
  mapping: SpeakerMapping | null | undefined
): Record<string, string> {
  if (!mapping) return {};
  const labels: Record<string, string> = {};
  for (const key of Object.keys(mapping)) {
    if (!SPEAKER_KEY_RE.test(key)) continue;
    labels[key] = mapping[key]?.name || `참석자 ${speakerNum(key)}`;
  }
  return labels;
}

/**
 * SPEAKER_XX → **순번 라벨**("참석자 N") 매핑. 매핑 여부와 무관하게 항상 순번을 반환한다
 * (이름이 있어도 "참석자 N"). N 규칙은 buildSpeakerLabels와 동일(SPEAKER_XX 숫자 직결).
 *
 * SPEAKER_XX가 함께 노출되는 곳(화자 매핑 탭의 식별 열·picker 제목 등)에서 raw 라벨과 병기해
 * "이 SPEAKER_03이 본문의 참석자 3"임을 잇는 보조 식별자로 쓴다.
 */
export function buildSpeakerNumbers(
  mapping: SpeakerMapping | null | undefined
): Record<string, string> {
  if (!mapping) return {};
  const numbers: Record<string, string> = {};
  for (const key of Object.keys(mapping)) {
    if (!SPEAKER_KEY_RE.test(key)) continue;
    numbers[key] = `참석자 ${speakerNum(key)}`;
  }
  return numbers;
}

// ─── 표시 시점 치환 ─────────────────────────────────────

/**
 * 회의록 표시용 markdown 생성 — SPEAKER_XX 라벨을 표시 라벨로 치환.
 * 매핑된 화자는 실제 이름, 미매핑 화자는 "참석자 N"(buildSpeakerLabels 규칙).
 * 긴 키부터 처리해 SPEAKER_10이 SPEAKER_1보다 먼저 치환되도록 함 (prefix 충돌 방지).
 *
 * mapping 포맷은 loadSpeakerMapping()이 반환하는 `{ SPEAKER_XX: { name, reason } }` 형태.
 *
 * 입력 nullable 허용 — 호출자가 `rawNotes != null ?` 분기할 필요 없이 일관 호출 가능.
 * md가 비어있으면 빈 문자열 반환.
 *
 * 치환 후에도 남은 raw SPEAKER_XX는 "참석자 N"으로 폴백 — 매핑 파일 부재(AI 다듬기 OFF 등)나
 * 매핑에 없는 화자가 본문에 있어도 내부 라벨이 사용자에게 노출되지 않게.
 */
export function substituteNames(
  md: string | null | undefined,
  mapping: SpeakerMapping | null | undefined
): string {
  if (!md) return "";
  if (!mapping) return fallbackSpeakerLabels(md);

  const labels = buildSpeakerLabels(mapping);
  const sorted = Object.keys(labels).sort((a, b) => b.length - a.length);
  let result = md;
  for (const sp of sorted) {
    result = result.replaceAll(sp, labels[sp]);
  }
  return fallbackSpeakerLabels(result);
}
