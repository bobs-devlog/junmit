// 사용자 화자분리 교정 — 전사본 라벨을 직접 치환·저장한다.
//
// 설계: 전사본 라벨 SSOT는 transcript_corrected.txt. 사용자 편집은 라인 prefix를 직접 치환해 저장한다
// (LLM용 transcript_speaker_edits.json + sidecar apply-edits 경로는 자동·임시 명세라 사용자 편집엔 부적합).
// /meeting 재작성 모드(meeting-notes.bak.* 존재)는 1단계를 skip하므로 이 직접 수정이 보존된다.
//
// 회의록(meeting-notes.md)은 줄-라인 대응이 없어 동기화하지 않는다(요약 본문). 라벨 변경은 표시 시점
// substituteNames(매핑 기반)로 흡수되며, 새 라벨 반영이 필요하면 /meeting 재작성으로 해소.
//
// 각 교정은 변경 직전 전사본 스냅샷을 반환 → UI가 "실행 취소"로 restoreSnapshot 호출 (한 단계 Undo).

import { invoke } from "@tauri-apps/api/core";

import { reassignSpeakerInTranscript, nextSpeakerLabel } from "./transcript";

const CORRECTED = "transcript_corrected.txt";
const RAW = "transcript.txt";

// 교정 직전 전사본 — 실행 취소(Undo)용.
export interface CorrectionSnapshot {
  transcript: string;
}

/**
 * 교정본 우선, 없거나 빈 문자열이면 원본을 읽어 교정본으로 승격(첫 교정 시).
 * `||` 로 빈 문자열도 raw fallback — TranscriptEditor의 표시 로직(`correctedText || rawText`)과
 * 일치시켜 화면 lines 인덱스와 저장 대상 텍스트의 줄 인덱스가 어긋나지 않게 한다.
 */
async function loadEditableTranscript(sessionPath: string): Promise<string> {
  const corrected = await invoke<string>("cmd_read_session_file", {
    sessionPath,
    filename: CORRECTED,
  }).catch(() => null);
  if (corrected) return corrected;
  const raw = await invoke<string>("cmd_read_session_file", {
    sessionPath,
    filename: RAW,
  }).catch(() => null);
  return raw ?? "";
}

async function writeTranscript(sessionPath: string, text: string): Promise<void> {
  await invoke<void>("cmd_write_session_file", {
    sessionPath,
    filename: CORRECTED,
    content: text,
  });
}

/**
 * 선택 줄(들)을 toLabel("__NEW__"면 새 빈 화자 라벨 생성)로 재할당.
 * 오할당 수정 / UNKNOWN 확정 / 과소분할·놓친 화자 빼내기.
 * 새 화자의 이름은 여기서 받지 않는다 — 라벨만 만들고, 이름은 전사본에서 그 라벨(칩) 클릭으로 지정
 * (다른 화자 이름 지정과 동일 경로 유지).
 */
export async function reassignLines(
  sessionPath: string,
  lineIndices: number[],
  toLabel: string
): Promise<{ changedLines: number; newLabel?: string; snapshot: CorrectionSnapshot }> {
  const text = await loadEditableTranscript(sessionPath);
  const snapshot: CorrectionSnapshot = { transcript: text };
  if (lineIndices.length === 0) return { changedLines: 0, snapshot };

  let target = toLabel;
  let newLabel: string | undefined;
  if (toLabel === "__NEW__") {
    target = nextSpeakerLabel(text);
    newLabel = target;
  }

  const { text: next, changed } = reassignSpeakerInTranscript(text, target, new Set(lineIndices));
  await writeTranscript(sessionPath, next);

  return { changedLines: changed, newLabel, snapshot };
}

/** 직전 교정 되돌리기 — 스냅샷의 전사본을 그대로 복원(한 단계 Undo). */
export async function restoreSnapshot(
  sessionPath: string,
  snapshot: CorrectionSnapshot
): Promise<void> {
  await writeTranscript(sessionPath, snapshot.transcript);
}
