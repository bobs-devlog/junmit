// transcript.txt 파싱·화자 라벨 교정 공통 유틸 — SPEAKER_XX/UNKNOWN 라벨 라인 형식의 단일 정규식 출처.
// TranscriptEditor의 라인 파싱과 화자분리 교정(라벨 재할당)이 같은 정규식을 공유한다.

// [SPEAKER_XX M:SS] text 또는 [UNKNOWN M:SS] text 형식.
// 그룹1=라벨(SPEAKER_\d+ | UNKNOWN), 그룹2=타임스탬프(M:SS), 그룹3=본문.
export const TRANSCRIPT_LINE_RE = /^\[(SPEAKER_\d+|UNKNOWN)\s+(\d+:\d+)\]\s*(.*)/;

// 라인 prefix `[<라벨> ` 만 매칭 (라벨만 교체할 때 사용. 시간·본문 불변).
const SPEAKER_PREFIX_RE = /^\[[^\s\]]+ /;

/**
 * transcript 텍스트에 **실제 등장하는 화자 라벨(SPEAKER_XX)** 집합을 등장 순서대로 반환.
 * UNKNOWN(LLM 판단 유보 구간)은 실제 화자가 아니므로 제외한다.
 */
export function extractSpeakerLabels(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(TRANSCRIPT_LINE_RE);
    if (!m) continue;
    const label = m[1];
    if (label === "UNKNOWN" || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * 전사에 등장하는 라벨 중 가장 큰 번호 +1 로 새 화자 라벨을 만든다 (`SPEAKER_NN`, 0-base %02d).
 * 빈 자리를 메우지 않고 항상 max+1 → 기존 라벨·과거 라벨과 충돌하지 않음.
 * 빈 전사면 SPEAKER_00. (sidecar MergeTranscript.swift의 `SPEAKER_%02d`와 동일 포맷.)
 */
export function nextSpeakerLabel(text: string | null | undefined): string {
  let max = -1;
  for (const label of extractSpeakerLabels(text)) {
    const m = label.match(/^SPEAKER_(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `SPEAKER_${String(max + 1).padStart(2, "0")}`;
}

/**
 * 전사본의 **지정한 줄들**의 화자 라벨을 toLabel로 재할당한다.
 * 라인 prefix `[<라벨> ` → `[<toLabel> ` 만 치환(시간·본문 불변). UNKNOWN 줄도 허용
 * (LLM 판단 유보 줄을 사용자가 특정 화자로 확정).
 *
 * `TRANSCRIPT_LINE_RE` 단위 매칭이라 SPEAKER_1 vs SPEAKER_10 부분문자열 충돌이 구조적으로 불가.
 * 이미 toLabel인 줄은 건너뛴다.
 */
export function reassignSpeakerInTranscript(
  text: string,
  toLabel: string,
  lineIndices: Set<number>
): { text: string; changed: number } {
  const lines = text.split("\n");
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lineIndices.has(i)) continue;
    const m = lines[i].match(TRANSCRIPT_LINE_RE);
    if (!m || m[1] === toLabel) continue;
    lines[i] = lines[i].replace(SPEAKER_PREFIX_RE, `[${toLabel} `);
    changed++;
  }
  return { text: lines.join("\n"), changed };
}
