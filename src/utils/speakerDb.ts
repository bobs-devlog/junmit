// 화자 사전(화자 음성 DB) read/write + 등록(enrollment) 유틸.
//
// 등록 트리거 = 사용자가 화자 매핑을 확정하는 순간(TranscriptEditor 핸들러 + 합치기 수락).
// 벡터 출처 = 세션 speaker_embeddings.json (화자분리 시점에 기록된 화자별 대표 임베딩.
// recording.wav는 화자분리 직후 삭제되므로 그 파일이 유일한 재료다).
// 축적된 DB는 다음 회의의 화자분리(pyannote_diarize.py)가 읽어 이름 추정을 프리필한다.
// 생체정보 성격이라 이 Mac 로컬 전용이며, 관리 화면("화자 사전")에서 삭제·비활성화 가능.

import { invoke } from "@tauri-apps/api/core";
import { loadMeetingMeta } from "@/utils/meetingMeta";

export interface SpeakerSample {
  session_id: string;
  speaker: string;
  capture_mode: string;
  date: string;
  title: string;
  vector: number[];
}

export interface SpeakerPerson {
  name: string;
  samples: SpeakerSample[];
}

export interface SpeakerDb {
  version: number;
  model: string;
  dim: number;
  people: SpeakerPerson[];
}

export interface SpeakerEmbeddings {
  model: string;
  dim: number;
  capture_mode?: string;
  speakers: Record<string, number[]>;
}

// 인물당 샘플 상한: DB 크기가 회의 수가 아니라 인물 수에 비례하게 고정하는 장치.
// 초과 시 오래된 것(배열 앞)부터 evict. 환경별(마이크/시스템 오디오) 샘플 다양성은
// 상한 안에서 자연 축적된다(멀티 엔롤먼트).
export const MAX_SAMPLES_PER_PERSON = 8;

const EMPTY_DB: SpeakerDb = { version: 1, model: "", dim: 0, people: [] };

export async function loadSpeakerDb(): Promise<SpeakerDb> {
  try {
    const db = await invoke<SpeakerDb>("cmd_read_speaker_db");
    return { ...EMPTY_DB, ...db, people: db.people ?? [] };
  } catch {
    return { ...EMPTY_DB };
  }
}

export async function saveSpeakerDb(db: SpeakerDb): Promise<void> {
  await invoke<void>("cmd_write_speaker_db", { db });
}

export async function getSpeakerProfileEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("cmd_get_speaker_profile_enabled");
  } catch {
    return true;
  }
}

export async function setSpeakerProfileEnabled(enabled: boolean): Promise<void> {
  await invoke<void>("cmd_set_speaker_profile_enabled", { enabled });
}

/** 세션 speaker_embeddings.json 로드 — 없으면 null (옛 세션·토글 OFF 세션·계산 실패). */
export async function loadSpeakerEmbeddings(
  sessionPath: string
): Promise<SpeakerEmbeddings | null> {
  const raw = await invoke<string | null>("cmd_read_session_file", {
    sessionPath,
    filename: "speaker_embeddings.json",
  }).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpeakerEmbeddings;
  } catch {
    return null;
  }
}

function sessionIdOf(sessionPath: string): string {
  return sessionPath.replace(/\/+$/, "").split("/").pop() ?? sessionPath;
}

/** (session_id, speaker) 키 샘플을 전 인물에서 제거. 빈 인물은 목록에서 삭제. */
function removeSample(db: SpeakerDb, sessionId: string, speaker: string): void {
  for (const person of db.people) {
    person.samples = person.samples.filter(
      (sample) => !(sample.session_id === sessionId && sample.speaker === speaker)
    );
  }
  db.people = db.people.filter((person) => person.samples.length > 0);
}

/**
 * 화자 확정 → 전역 DB 등록. (session_id, speaker) 키 결정론 upsert:
 * ① 전 인물에서 동일 키 샘플 제거(이름 변경 = 이동) ② 대상 인물에 append(없으면 생성)
 * ③ 상한 초과 시 오래된 것부터 evict.
 *
 * 반환 true = 실제 등록됨(토스트 문구 분기용). false = skip(토글 OFF·임베딩 없음·해당
 * SPEAKER 벡터 없음). 실패도 throw 대신 false: 등록 실패가 매핑 저장을 막으면 안 된다.
 */
export async function enrollSpeakerVoice(
  sessionPath: string,
  speaker: string,
  name: string
): Promise<boolean> {
  try {
    if (!(await getSpeakerProfileEnabled())) return false;
    const embeddings = await loadSpeakerEmbeddings(sessionPath);
    const vector = embeddings?.speakers?.[speaker];
    if (!vector?.length) return false;

    const meta = await loadMeetingMeta(sessionPath);
    const sessionId = sessionIdOf(sessionPath);
    const db = await loadSpeakerDb();
    if (!db.model) db.model = embeddings!.model ?? "";
    if (!db.dim) db.dim = embeddings!.dim ?? vector.length;

    removeSample(db, sessionId, speaker);
    // 인물 조회는 대소문자 무시: "bobs"/"Bobs" 같은 표기 변형이 두 인물로 갈라지면
    // 같은 목소리끼리 margin 경합이 생겨 그 사람의 프리필이 영구 보류된다.
    // 표기는 먼저 등록된 이름을 유지(세션 매핑의 표기는 그대로 두고 DB만 접어서 병합).
    const trimmed = name.trim();
    const nameKey = trimmed.toLowerCase();
    let person = db.people.find((p) => p.name.trim().toLowerCase() === nameKey);
    if (!person) {
      person = { name: trimmed, samples: [] };
      db.people.push(person);
    }
    person.samples.push({
      session_id: sessionId,
      speaker,
      capture_mode: embeddings!.capture_mode ?? meta?.capture_mode ?? "mic",
      date: meta?.date ?? "",
      title: meta?.title ?? "",
      vector,
    });
    if (person.samples.length > MAX_SAMPLES_PER_PERSON) {
      person.samples = person.samples.slice(-MAX_SAMPLES_PER_PERSON);
    }
    await saveSpeakerDb(db);
    return true;
  } catch {
    return false;
  }
}

/** 미확인 되돌림: (session_id, speaker) 샘플을 전 인물에서 제거. */
export async function unenrollSpeakerVoice(sessionPath: string, speaker: string): Promise<void> {
  try {
    const db = await loadSpeakerDb();
    const before = db.people.reduce((count, p) => count + p.samples.length, 0);
    removeSample(db, sessionIdOf(sessionPath), speaker);
    const after = db.people.reduce((count, p) => count + p.samples.length, 0);
    if (after !== before) await saveSpeakerDb(db);
  } catch {
    // 제거 실패는 비치명. 다음 등록/삭제 때 자연 정리된다.
  }
}
