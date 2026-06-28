import type { SessionSteps } from "./types";

// 화면 모드 — UI 라우팅용. Activity와 직교: 어느 화면(Screen)에서든 무슨 작업(Activity)이 도는지 별도 표현.
export const Screen = {
  Loading: "loading",
  Error: "error",
  Setup: "setup",
  Home: "home", // 새 회의 시작 메인 화면 (캘린더 선택 또는 수동 입력)
  History: "history", // 회의 기록 목록
  Session: "session", // sessionDir 진입 후 화면 (조회/작업 진행 모두 포함)
} as const;

export type Screen = (typeof Screen)[keyof typeof Screen];

// 활동성 — Screen=Session에서만 의미. 사이드바 컨트롤 분기와 메인 컴포넌트 라우팅에 사용.
// Phase 1 LLM은 Correcting → Composing → Idle로 단계 전환 (phase_step_done "correct" 신호로 분리).
export const Activity = {
  Idle: "idle", // 사용자 결정 대기
  Recording: "recording", // 녹음 중
  Saving: "saving", // 스테이징 wav → 16k wav 변환·믹스
  Processing: "processing", // 전사 + 화자분리
  Correcting: "correcting", // LLM 후보정 (Phase 1 1·2단계: 화자 라벨 교정·이름 매칭, 정밀 시 전사 교정)
  Composing: "composing", // LLM 회의록 작성 (Phase 1 3·4단계)
  Publishing: "publishing", // LLM Confluence/Jira 등록
} as const;

export type Activity = (typeof Activity)[keyof typeof Activity];

// Activity별 시각 표현 자료 — 라벨 + tone (CSS 클래스명 매핑용).
// Record라 새 Activity 추가 시 메타 누락하면 컴파일 에러.
// tone 값은 Sidebar.module.css의 클래스명과 1:1 매칭 — `.idle`, `.recording`, `.processing`.
export type ActivityTone = "idle" | "recording" | "processing";

const ACTIVITY_META: Record<Activity, { label: string; tone: ActivityTone }> = {
  [Activity.Idle]: { label: "대기", tone: "idle" },
  [Activity.Recording]: { label: "녹음 중", tone: "recording" },
  [Activity.Saving]: { label: "저장 중...", tone: "processing" },
  [Activity.Processing]: { label: "오디오 처리 중", tone: "processing" },
  [Activity.Correcting]: { label: "AI 후보정 중", tone: "processing" },
  [Activity.Composing]: { label: "회의록 작성 중", tone: "processing" },
  [Activity.Publishing]: { label: "Confluence 등록 중", tone: "processing" },
};

export function activityMeta(a: Activity) {
  return ACTIVITY_META[a];
}

// 회의 진행 5단계의 단일 진실 원천.
// 사용처: Sidebar stepper, SessionList 카드, ProcessingPanel, nextPendingStep 헬퍼.
export const Step = {
  Transcribe: "transcribe",
  Diarize: "diarize",
  Correct: "correct",
  Notes: "notes",
  Publish: "publish",
} as const;

export type StepId = (typeof Step)[keyof typeof Step];

export interface StepInfo {
  id: StepId;
  label: string;
  description: string;
  icon: string;
  field: keyof SessionSteps;
}

export const STEPS: ReadonlyArray<StepInfo> = [
  {
    id: Step.Transcribe,
    label: "전사",
    description: "음성을 텍스트로 변환",
    icon: "🎤",
    field: "transcribed",
  },
  {
    id: Step.Diarize,
    label: "화자분리",
    description: "누가 말했는지 구분",
    icon: "🗣",
    field: "diarized",
  },
  {
    id: Step.Correct,
    label: "AI 후보정",
    description: "화자 정리 + 정밀 시 전사 교정",
    icon: "✏️",
    field: "corrected",
  },
  {
    id: Step.Notes,
    label: "회의록",
    description: "회의록 작성",
    icon: "📋",
    field: "notes_written",
  },
  {
    id: Step.Publish,
    label: "Confluence 등록",
    description: "회의록 게시 (Jira 통합은 추후)",
    icon: "📤",
    field: "published",
  },
];

export function stepIndexById(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function nextPendingStep(steps: SessionSteps): StepInfo | undefined {
  return STEPS.find((s) => !steps[s.field]);
}

// 녹음 시간 관련 — MeetingSelector(안내 문구), RecordingScreen(타이머·알림) 공유
export const DEFAULT_DURATION_MIN = 60; // duration 지정 없을 때 기본값

// 종료 시각 리마인더 — 자동 중지 없음. duration 도달 시 플로팅 윈도우 띄움.
// snooze(다시 알림) 누르면 아래 간격만큼 뒤에 다시 표시. 사용자가 "지금 종료"를 누를 때까지 반복.
export const REMINDER_SNOOZE_MIN = 10; // 모든 회의 공통 snooze 간격

// macOS 시스템 설정의 마이크 개인정보 페이지 — 권한 거부/제한 시 "시스템 설정 열기"가 가리키는 URL.
// MeetingSelector·RecordingScreen이 공유(한쪽만 고치면 어긋나는 매직스트링 제거).
export const MIC_PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

// macOS 시스템 설정의 캘린더 개인정보 페이지 — 권한 화면의 "시스템 설정 열기"가 가리키는 URL.
export const CALENDAR_PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";

// macOS 시스템 설정의 "화면 및 시스템 오디오 녹화" 페이지 — 시스템 오디오 캡처 권한(kTCCServiceAudioCapture)이
// 이 창에 표시된다(Apple이 화면 녹화와 같은 pane에 묶음 — 우리는 오디오만 사용, 화면은 보지 않음).
export const SYSTEM_AUDIO_PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

// macOS 캘린더 앱 — 회의용 캘린더(Google·회사 계정 등)를 연동하도록 캘린더 앱을 연다.
// 시스템 설정 "인터넷 계정"은 로그인이 브라우저로 빠져 연동 창 복귀가 번거로운 반면, 캘린더 앱에서
// "캘린더 > 계정 추가"로 로그인하는 흐름이 더 매끄럽고 앱이 열리며 동기화도 트리거된다.
// (앱 환경설정 다이얼로그를 직접 여는 공식 URL은 없어 앱 실행까지만 가능 — 계정 추가는 사용자가 메뉴로)
export const CALENDAR_APP_PATH = "/System/Applications/Calendar.app";

// macOS 시스템 설정의 알림 페이지 — 알림이 차단됐을 때 "시스템 설정 열기"가 가리키는 URL.
export const NOTIFICATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.notifications";
