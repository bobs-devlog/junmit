import type { ReactNode } from "react";

// ── Toast ────────────────────────────────────────
export type ToastType = "success" | "error" | "info";

export interface ToastData {
  message: string;
  type: ToastType;
  duration?: number;
  id: number;
}

export interface ToastApi {
  show: (message: string, type?: ToastType, duration?: number) => void;
  dismiss: () => void;
  success: (msg: string, duration?: number) => void;
  error: (msg: string, duration?: number) => void;
  info: (msg: string, duration?: number) => void;
}

// ── Confirm ──────────────────────────────────────
export interface ConfirmOptions {
  title?: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

// 통지(alert)용 — 단일 버튼. 취소 개념이 없어 결정형(ConfirmOptions)과 분리.
export interface AlertOptions {
  title?: string;
  body?: ReactNode;
  confirmLabel?: string;
}

// 같은 모달이 결정(confirm)·통지(alert)를 모두 렌더. hideCancel은 통지일 때 취소 버튼을 숨기는
// 내부 플래그(외부 API는 confirm/alert로 분리).
export interface DialogConfig {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  hideCancel: boolean;
}

export interface DialogApi {
  // 결정 — 확인/취소 2버튼. 확인=true, 취소=false.
  confirm: (options?: ConfirmOptions) => Promise<boolean>;
  // 통지 — 단일 버튼. 어떻게 닫든 동일(결과 없음).
  alert: (options?: AlertOptions) => Promise<void>;
}

// ── Speaker mapping ──────────────────────────────
export interface SpeakerEntry {
  name: string;
  reason: string;
  // 사용자가 이 매칭을 명시 확정했는지. 없으면(레거시) name 유무로 추정/미확인을 파생.
  // AI sub-agent는 절대 쓰지 않음(추정 또는 미확인만 산출) — 확정은 오직 사용자 액션.
  confirmed?: boolean;
}

export type SpeakerMapping = Record<string, SpeakerEntry>;

// ── Speaker similarity (합치기 제안) ──────────────
// 화자분리가 한 사람을 여러 SPEAKER로 쪼갠 과분할 후보. pyannote_diarize.py가
// 화자별 임베딩 쌍별 코사인으로 산출(자동 병합 X — 후보만). 사용자가 "같은 분"이면
// 두 SPEAKER에 같은 이름을 부여(가역). speaker_similarity.json 스키마.
export interface SimilarityCandidate {
  a: string; // SPEAKER_XX (작은 번호)
  b: string; // SPEAKER_XX (큰 번호)
  similarity: number; // 0~1 코사인
}

export interface SpeakerSimilarity {
  threshold: number;
  candidates: SimilarityCandidate[];
  dismissed: string[]; // "SPEAKER_01|SPEAKER_06" (pairKey) — 사용자가 거절한 쌍
}

// ── Calendar / Meeting ───────────────────────────
// 캘린더 참석자 — 이메일(안정 식별자) + EKParticipant.name 원시값.
// 표시 이름은 프론트엔드가 캐시·휴리스틱으로 해결 (resolveAttendeeName).
export interface Attendee {
  email: string;
  name: string;
}

export interface CalendarEvent {
  title: string;
  attendees: Attendee[];
  duration_min?: number;
  // 백엔드는 "HH:MM-HH:MM" 형태의 단일 time 문자열을 반환
  time?: string;
  start?: string;
  end?: string;
  // 캘린더 description을 Markdown으로 변환한 본문 (Swift측에서 변환). 비어있을 수 있음.
  notes?: string;
}

export interface Meeting {
  title: string;
  attendees: string[];
  meetingType?: string;
  duration?: number;
  // 캘린더 시간(예: "14:00-15:00") — 캘린더 이벤트 선택 시에만 채워짐.
  time?: string;
  // 사용자가 편집한 회의 컨텍스트 (캘린더 notes 시드 + 자유 편집).
  agenda?: string;
  // "calendar" | "manual" — 회의 정보 출처.
  source?: "calendar" | "manual";
  // 정밀 교정(text-correction) 여부 — 녹음 시작 설정의 토글. true면 /meeting Phase-1이 전사
  // 텍스트 교정까지 수행(느리지만 전사본이 깔끔). 기본 true(정밀, opt-out — 끄면 빠른 경로).
  detailedCorrection?: boolean;
}

// ── 녹음 중 메모 ─────────────────────────────────
// 녹음 중 사용자가 남기는 타임스탬프 메모. 종료 시 세션 디렉토리의 notes.json으로 flush되어
// /meeting 스킬이 화자 식별·회의록 작성에 활용한다.
//   speaker — 참석자 칩 탭. 그 시점 transcript 라벨과 교차참조해 SPEAKER_XX→이름 앵커로 사용
//   text    — 자유 메모 한 줄
export type MeetingNoteKind = "speaker" | "text";

export interface MeetingNote {
  // 녹음 시작 기준 경과 초 (recorder.elapsed).
  t: number;
  kind: MeetingNoteKind;
  // kind === "speaker"일 때 참석자 이름.
  speaker?: string;
  // kind === "text"일 때 메모 본문.
  text?: string;
}

// MeetingSelector 버튼 옵션 — `cmd_list_meeting_types` 응답.
// `auto`는 디렉토리에 파일이 없는 가상 옵션이라 프론트가 prepend.
export interface MeetingTypeOption {
  id: string;
  label: string;
  description: string;
}

// 세션 디렉토리의 `meeting.json` — 회의 메타데이터의 단일 진실 원천.
// `time`은 캘린더 이벤트일 때만 채워진다.
export interface MeetingMeta {
  title: string;
  date: string;
  time?: string;
  type: string;
  attendees: string[];
  agenda: string;
  source: "calendar" | "manual";
  // 정밀 교정 여부 — true면 전사 텍스트까지 교정됨(전사본 탭 "정밀 교정" 배지 분기에 사용).
  detailed_correction?: boolean;
  // 녹음 캡처 모드 — "mic"(마이크만) | "mic+system"(시스템 오디오 포함). 부재=마이크만.
  // create 시 의도로 기록되고 convert가 실제 캡처 결과로 교정한다.
  capture_mode?: "mic" | "mic+system";
}

// ── Recorder ─────────────────────────────────────
export interface Recorder {
  isRecording: boolean;
  elapsed: number;
  level: number;
  abort: () => void;
  // 마이크 녹음 시작. 시스템 오디오는 항상 함께 캡처를 시도한다(OS 권한이 게이트). 레벨 미터엔 둘을 합성.
  start: () => Promise<void>;
  // 녹음 종료. 마이크·시스템 캡처를 정지한다. 반환: 저장할 녹음이 캡처됐는지(true=세션 저장 진행).
  // 네이티브가 직접 스테이징 파일에 기록하므로 Blob을 반환하지 않는다(파일은 Rust가 읽음).
  stop: () => Promise<boolean>;
}

// ── Session ──────────────────────────────────────
// 백엔드(cmd_find_sessions 등)가 반환하는 세션 메타. ResumableSession (src-tauri/session.rs) shape에 맞춰 정의.
export interface SessionSteps {
  transcribed: boolean;
  diarized: boolean;
  corrected: boolean;
  notes_written: boolean;
  /** 녹음에 발화가 없어(무음) diarize·회의록을 건너뛴 세션. transcribe_result.json에서 파생. */
  no_speech: boolean;
}

export interface Session {
  path: string;
  title: string;
  date: string;
  time: string;
  steps: SessionSteps;
  [key: string]: unknown;
}

// ── Pipeline step (constants.ts와 일치) ──────────
export interface PipelineStep {
  id: string;
  label: string;
  description: string;
  icon: string;
}

// ── PTY spawn request (App → TerminalPanel) ──────
export interface SpawnRequest {
  command: string;
  args: string[];
  ts: number;
}

// 회의록 AI 백엔드. 기본 claude. 사용자가 선택한 값을 Rust가 영속 저장(cmd_get/set_active_cli).
// "mlx" = 로컬 LLM(에이전트 아님, 결정론적 파이프라인). /meeting(회의록 작성)만 지원.
// "antigravity" = Google Antigravity CLI(agy). codex와 같은 에이전트 티어이며 스킬 규약도
// codex 산출물(.agents/skills + AGENTS.md)을 공유한다.
// 이름 주의: "Cli"는 claude/codex만 있던 시절의 역사적 이름 — mlx는 CLI가 아니며 실제 의미는
// "AI 백엔드"다. 리네임은 전층 계약(Rust 커맨드명·디스크 파일 active_cli·라우트)이라 별도 작업으로.
export type Cli = "claude" | "codex" | "mlx" | "antigravity";

// cmd_detect_clis 결과 — 온보딩 "AI 도구 선택" 화면 카드 상태.
// claude/codex는 junmit 전용 환경 기준 인증까지 감지(claude: `auth status`, codex: `login status`).
// antigravity는 격리 환경이 없어 사용자 전역 로그인 기준(`agy models` 출력 판별 — session.rs 참고).
// 에이전트 CLI가 하나 더 늘면 평면 필드 대신 맵 구조로 리팩터할 것(와이어 계약 변경이라 별도 작업).
export interface CliAvailability {
  claude: boolean;
  claude_authed: boolean;
  codex: boolean;
  codex_authed: boolean;
  antigravity: boolean;
  antigravity_authed: boolean;
}

// ── 의존성 체크 결과 ──────────────────────────────
export interface DepsCheck {
  installed: boolean;
  missing?: string[];
  [key: string]: unknown;
}
