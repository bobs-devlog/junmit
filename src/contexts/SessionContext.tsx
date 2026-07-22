import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { Activity, Step, STEPS, cliHasAgent } from "@/constants";
import type { StepId } from "@/constants";
import type { Cli, Meeting, SessionSteps, SpawnRequest } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadMeetingMeta, updateMeetingMeta } from "@/utils/meetingMeta";
import { loadCorrectedTranscript, loadMeetingNotesMd } from "@/utils/meetingNotes";
import { killPty, sendAssistRequest, sendSlashCommand } from "@/utils/pty";
import {
  buildSpawnRequest,
  buildClaudeResumeRequest,
  buildCodexResumeRequest,
} from "@/utils/spawn";
import {
  cancelMeetingWork,
  clearAgentSession,
  parseHeadlessLine,
  readAgentSession,
  writeAgentSession,
} from "@/utils/headless";
import { track, meetingTypeCategory } from "@/utils/analytics";
import { sendNotification } from "@/utils/notification";

// 검증 잠금 고착 회수 타임아웃 — verify 신호가 유실(스킬 크래시·PTY 사망)돼도 이 시간이 지나면
// 편집 잠금을 푼다. 검증 wall time 실측 2~4분이라 정상 경로를 방해하지 않는 여유값.
const VERIFY_LOCK_TIMEOUT_MS = 10 * 60_000;

// 새 회의 시작·reset 시 초기 진척도. 화면이 직접 사용 가능 (예: 처리 단계 reset).
export const EMPTY_STEPS: SessionSteps = {
  transcribed: false,
  diarized: false,
  corrected: false,
  notes_written: false,
  no_speech: false,
};

// PTY 명령 빌더는 `@/utils/spawn`에 공유 (유형 관리 화면과 단일 소스). 스킬은 APP_SESSION_DIR
// env에서 sessionDir read, meeting 스킬은 기존 $ARGUMENTS 사용 (외부 bash quote가 보호).

// SessionContext는 데이터 + 모든 transition을 책임진다 (action 메소드 패턴).
// 화면은 의도만 표현 — 데이터 변경 책임은 Context에 캡슐화.
interface SessionContextValue {
  // 데이터 (read-only로 노출)
  meeting: Meeting | null;
  sessionDir: string | null;
  steps: SessionSteps;
  activity: Activity;
  // AI가 화자 매핑 파일을 쓰는 동안 사용자 편집을 잠가야 하는 상태.
  // 매핑을 쓰는 마지막 주체는 1단계 화자 작업(phase_step_done "correct"까지)이므로, 그 뒤
  // (Composing = 회의록 작성·검증, 매핑은 읽기만)엔 잠그지 않는다. mlx(로컬)는 correct 단계
  // 없이 Composing 안에서 매핑을 준비하므로 corrected=false인 Composing은 여전히 잠금.
  // 화자매칭·전사본·합치기 제안이 공통으로 쓴다(각자 activity 조합을 재계산하지 않도록 단일 출처).
  isEditLocked: boolean;
  currentStepId: StepId | null;
  spawnRequest: SpawnRequest | null;
  appDir: string | null;
  signalDir: string | null;
  cli: Cli;
  refreshKey: number;
  // headless(claude -p) 실행이 작업 패널의 주체인 상태 — WorkArea가 터미널 대신
  // AgentProgressPanel을 렌더할지의 단일 출처 (mlx의 localBackend와 같은 결).
  headlessActive: boolean;

  // 환경 초기화 (AppShell이 cmd_get_app_dir / cmd_get_signal_dir / cmd_get_active_cli 결과를 set)
  setAppDir: (dir: string) => void;
  setSignalDir: (dir: string) => void;
  setCli: (cli: Cli) => void;

  // 녹음 취소 — 자동 진행 흐름이 isCancelled() 보고 분기
  setCancelled: (v: boolean) => void;
  isCancelled: () => boolean;
  // activity 최신값 ref — listen 콜백 같은 stale closure 회피용 (read-only)
  activityRef: RefObject<Activity>;

  // ─── Claude 작업 패널(drawer) ─────────────────────────────
  // Section 10 정책: 진입 default closed, 비-Idle 진입 시 자동 expand, 자동 close 없음.
  // 사용자 close 후에도 새 작업 trigger 시 자동 expand 재작동.
  drawerOpen: boolean;
  openDrawer: () => void;
  // closeDrawer는 패널 close + "✓ 완료" 띠 해제까지 함께 — 둘은 panel UX 단위.
  closeDrawer: () => void;
  // toggleDrawer — WorkArea 우측 끝의 absolute 토글 버튼이 호출. drawer 상태에 따라 open/close.
  toggleDrawer: () => void;
  // phase_done OSC 신호로 정상 완료한 직전 Activity. WorkArea가 "✓ 완료" 띠 표시에 사용.
  // 사용자 Esc·PTY 자발 종료 등 미완료 경로(notifyPtyExit)는 여기 안 건드림 — 잘못된 완료 표시 방지.
  completedActivity: Activity | null;
  // 단계 완료 시 SessionViewer가 자동 이동할 sub-tab id (예: "transcript", "notes").
  // OSC 신호 핸들러가 set, 사용자 탭 클릭 시 clear → 다음 단계 완료까지는 사용자 선택 유지.
  focusSubtab: string | null;
  clearFocusSubtab: () => void;
  // 전사본 특정 라인으로 이동 요청(1-based) — 검증 영수증의 근거(L{n}) 클릭이 set.
  // focusSubtab("transcript")과 함께 걸어 탭 전환을 트리거하고, TranscriptEditor가 스크롤
  // 적용 후 clear하는 1회성 요청 (focusSubtab과 같은 "요청 → 소비 후 clear" 관례).
  transcriptFocusLine: number | null;
  requestTranscriptLine: (line: number) => void;
  clearTranscriptFocusLine: () => void;
  // 회의록 자기검증(6단계)이 도는 동안 true — 회의록 본문 편집·유형 변경을 잠근다(검증 적용과
  // 사용자 편집의 동시 쓰기 충돌 원천 차단). phase_done 시 meeting.json의 notes_verification으로
  // 판정해 set, 스킬이 검증 종료 시 항상 보내는 phase_step_done "verify"로 clear. 신호 유실
  // (PTY 사망 등)엔 타임아웃·PTY 종료·에러·세션 전환이 clear — 잠금 고착 방지.
  isVerifying: boolean;
  // 회의록 탭 전용 스코프 재로드 키 — 검증 완료(verify 신호)가 bump. refreshKey(전체 remount)와
  // 달리 전사본 탭을 건드리지 않아, 공개 직후 사용자의 화자 매핑 작업(스크롤·팝오버)이 끊기지 않는다.
  notesRefreshKey: number;
  // SessionViewer 활성 탭 — Context가 소유해 refresh 신호의 전체 remount에도 사용자가 보던 탭을
  // 유지한다(tabBanner와 같은 이유). focusSubtab(자동 이동 요청)과 별개인 "현재 선택"의 단일 출처.
  viewerTab: string | null;
  setViewerTab: Dispatch<SetStateAction<string | null>>;
  // 회의록 편집 모드 진입/이탈 보고(Notes가 호출) — 편집 중 도착한 범용 refresh(전체 remount)를
  // 보류했다가 편집 종료 시 반영해, 미저장 편집이 remount로 소실되는 것을 막는다.
  setNotesEditing: (editing: boolean) => void;
  // 회의록 자동 작성 preflight(completeProcessing, 전사·화자분리 후 **자동** 전이 지점)가 로그인
  // 만료를 감지하면 이 CLI로 set — 스폰하지 않고 Idle로 되돌린 뒤 사이드바 재로그인 안내 + macOS
  // 알림으로 복귀를 유도한다(자리 비운 사용자용). 수동 "회의록 작성"은 preflight 없이 즉시 진행하므로
  // 이 값을 set하지 않고 clear만 한다(만료면 터미널 raw 노출로 복구). persistent(복귀해도 유지 —
  // 토스트 아님). clear 지점: 수동 작성 시작·자동 작성 성공·세션 전환, 그리고 clearLoginExpired
  // (SessionScreen이 세션 재진입 시 현재 인증을 재확인해 유효하면 걷음 — 재로그인 후 stale 방지).
  loginExpiredCli: Cli | null;
  clearLoginExpired: () => void;
  // 자동 탭 전환 직후 SessionViewer에 띄울 안내 배너. show 1회 호출 → 5초 자동 dismiss.
  // SessionViewer가 refreshKey 변경으로 remount되어도 표시 상태 유지하기 위해 Context가 소유 (인스턴스 state X).
  tabBanner: string | null;
  dismissTabBanner: () => void;

  // ─── 화면 전환 (entry transition) ─────────────────────────
  startNewMeeting: (meeting: Meeting) => void;
  openExistingMeeting: (session: { title: string; path: string; steps: SessionSteps }) => void;
  resetSession: () => void;

  // ─── 녹음 (RecordingScreen) ──────────────────────────────
  markSavingStarted: () => void;
  finishRecording: (sessionDir: string) => void;

  // ─── 처리·LLM 작업 (SessionScreen) ────────────────────────
  enterProcessing: () => void;
  resetSessionToRecording: () => Promise<void>;
  resetSessionToDiarized: () => Promise<void>;
  completeProcessing: () => Promise<void>;
  // 전사 단계에서 무음("발화 없음") 감지 → diarize·회의록 건너뛰고 Idle로. PTY spawn 안 함.
  markNoSpeech: () => void;
  // "그래도 회의록 작성하기" — 무음 판정을 무효화하고 보존된 전사로 파이프라인 재개.
  overrideNoSpeech: () => Promise<void>;
  startComposing: () => Promise<void>;
  restartCompose: (newType: string, aiPolish?: boolean) => Promise<void>;
  // meeting.json.title 갱신 + context 동기화. 빈 문자열은 거절.
  updateTitle: (title: string) => Promise<void>;
  updateAttendees: (attendees: string[]) => Promise<void>;
  markPipelineSubStep: (stepId: string) => void;
  // ProcessingPanel이 각 단계(transcribe/diarize) 완료 시 개별 호출 — stepper ✓ 즉시 반영.
  markStepDone: (stepId: StepId) => void;
  notifyPtyExit: () => void;
  // CLI 전환 등에서 PTY+로컬(mlx) 작업을 함께 중단하고 진행 상태를 정리 (회의 컨텍스트는 유지).
  abortLlmWork: () => Promise<void>;

  // ─── PTY 직접 조작 (Tier 1 stdin write 패턴 위해 노출) ──────
  // 살아있는 PTY가 있으면 stdin에 텍스트 그대로 write. 없으면 throw.
  // 호출자(예: 다듬기)가 isPtyAlive() 먼저 확인 후 호출하는 패턴.
  isPtyAlive: () => Promise<boolean>;
  sendPtyInput: (data: string) => Promise<void>;
  // 새 PTY spawn — 외부에서 명시 spawn 트리거 (예: Tier 2 fresh PTY).
  // 호출자가 슬래시 커맨드 명시 (예: `/meeting ${sessionDir}`).
  spawnPty: (slashCommand: string) => void;

  // "AI에게 추가 요청" — 사이드바·빈 상태 UI 공통 진입점. 요청 텍스트를 먼저 받아(입력 선행)
  // drawer expand + tier별로 실어 보낸다 (Tier 1 stdin / resume·fresh spawn 초기 프롬프트 병기).
  requestAi: (request: string) => Promise<void>;
  // requestAi 전송마다 bump — WorkArea→TerminalWorkspace가 터미널 focus 트리거로 소비해
  // 폼 전송 직후 키보드 입력이 바로 터미널 입력창으로 가게 한다.
  terminalFocusKey: number;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [sessionDir, setSessionDir] = useState<string | null>(null);
  const [steps, setSteps] = useState<SessionSteps>(EMPTY_STEPS);
  const [activity, setActivity] = useState<Activity>(Activity.Idle);
  const [currentStepId, setCurrentStepId] = useState<StepId | null>(null);
  const [spawnRequest, setSpawnRequest] = useState<SpawnRequest | null>(null);
  const [appDir, setAppDirState] = useState<string | null>(null);
  const [signalDir, setSignalDirState] = useState<string | null>(null);
  const [cli, setCliState] = useState<Cli>("claude");
  const [refreshKey, setRefreshKey] = useState(0);
  // Claude 작업 패널 — 회의 진입 시 default closed (Section 10).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // phase_done으로 정상 완료한 작업 종류 — WorkArea "✓ 완료" 띠 표시.
  // notifyPtyExit(미완료 경로)에선 set하지 않음 (잘못된 완료 표시 방지).
  const [completedActivity, setCompletedActivity] = useState<Activity | null>(null);
  // 단계 완료 시 SessionViewer를 자동 이동시킬 sub-tab. OSC 신호 핸들러가 set, 사용자가 탭 클릭하면 clear.
  const [focusSubtab, setFocusSubtab] = useState<string | null>(null);
  // 전사본 라인 이동 요청(1-based) — 검증 영수증 근거 클릭이 set, TranscriptEditor가 소비 후 clear.
  const [transcriptFocusLine, setTranscriptFocusLine] = useState<number | null>(null);
  // 자기검증 진행 중 — 회의록 편집·유형 변경 잠금의 단일 출처.
  const [isVerifying, setIsVerifying] = useState(false);
  // 회의록 탭 스코프 재로드 키 — verify 신호가 bump (전체 remount인 refreshKey와 분리).
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);
  // SessionViewer 활성 탭 — refresh remount에도 사용자가 보던 탭 유지 (tabBanner와 같은 소유 이유).
  const [viewerTab, setViewerTab] = useState<string | null>(null);
  const verifyTimerRef = useRef<number | null>(null);
  // 회의록 편집 중 여부 + 그동안 보류된 범용 refresh — 편집 종료 시 반영.
  const notesEditingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  // 자동 작성 preflight(completeProcessing)가 감지한 로그인 만료 CLI (persistent — 복귀해도 유지).
  const [loginExpiredCli, setLoginExpiredCli] = useState<Cli | null>(null);
  // headless(claude -p) 실행이 현재 작업 패널의 주체인지 — WorkArea가 터미널 대신
  // AgentProgressPanel을 보여줄지의 단일 출처. headless 실행 시작 시 true, PTY spawn이 일어나는
  // 모든 지점·세션 전환에서 false. Idle 복귀 후에도 유지해 패널에 최종 상태가 잔존한다
  // (LocalProgressPanel과 동일 체감 — drawer를 닫기 전까지 결과 확인 가능).
  const [headlessActive, setHeadlessActive] = useState(false);
  // headless 스트림의 최종 result 이벤트(is_error·본문) — runHeadlessMeeting 실패 배너에
  // 에러 원문(로그인 만료·한도 소진 안내 등)을 병기하기 위한 보관. 실행 시작 시 초기화.
  type HeadlessResult = { isError: boolean; text: string };
  const headlessResultRef = useRef<HeadlessResult | null>(null);
  // /assist resume PTY의 스폰 시각 — 직후(10초 내) pty:exit면 무효 session_id로 보고
  // agent_session.json을 비워 다음 클릭이 fresh spawn 폴백을 타게 한다(notifyPtyExit).
  const resumeSpawnAtRef = useRef<number | null>(null);
  // 현재 살아있는 PTY 대화에서 /assist 스킬이 이미 진입했는지 — Tier 1 요청 전달 시
  // 스킬 트리거를 최초 1회만 붙이기 위한 표식(재트리거는 스킬 재로드·재인사 중복).
  // /assist 프롬프트로 spawn되면 true, 다른 프롬프트의 새 spawn·PTY 종료·작업 중단에서 false.
  const assistStartedRef = useRef(false);
  // requestAi 전송마다 bump — TerminalWorkspace가 터미널 focus 트리거로 소비.
  const [terminalFocusKey, setTerminalFocusKey] = useState(0);
  // 자동 탭 전환 안내 배너 — Context가 소유해서 SessionViewer remount(refresh 신호 등)에도 표시 상태 유지.
  const [tabBanner, setTabBanner] = useState<string | null>(null);
  const tabBannerTimerRef = useRef<number | null>(null);
  const showTabBanner = useCallback((message: string) => {
    if (tabBannerTimerRef.current != null) {
      clearTimeout(tabBannerTimerRef.current);
    }
    setTabBanner(message);
    tabBannerTimerRef.current = window.setTimeout(() => {
      setTabBanner(null);
      tabBannerTimerRef.current = null;
    }, 5000);
  }, []);
  const dismissTabBanner = useCallback(() => {
    if (tabBannerTimerRef.current != null) {
      clearTimeout(tabBannerTimerRef.current);
      tabBannerTimerRef.current = null;
    }
    setTabBanner(null);
  }, []);
  const cancelledRef = useRef(false);
  const activityRef = useRef<Activity>(activity);
  // steps 최신값 ref — startComposing 같은 콜백이 stale closure 회피하며 corrected 분기 결정.
  const stepsRef = useRef<SessionSteps>(steps);
  // app:signal 리스너(빈 deps)에서 사용량 이벤트에 붙일 cli·회의유형을 stale 없이 읽기 위한 ref.
  const cliRef = useRef<Cli>(cli);
  const meetingRef = useRef<Meeting | null>(meeting);
  // phase_done 핸들러(빈 deps 리스너)가 meeting.json 경로를 stale 없이 읽기 위한 ref.
  const sessionDirRef = useRef<string | null>(sessionDir);
  // 회의록 작성 로그인 preflight를 파이프라인(전사·화자분리)과 **병렬로 미리** 던져두는 캐시.
  // Processing 진입 시 발사 → completeProcessing이 결과만 읽어(대개 이미 resolve) 스폰 직전 대기·
  // stall이 사라진다. 전사·화자분리는 auth가 불필요해 병렬이 안전하고, 특히 antigravity(~수초 서버
  // 왕복)의 지연이 화자분리 로딩 뒤에 숨는다. ref가 비어있으면 completeProcessing이 즉석 체크로 폴백.
  const authCheckRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    activityRef.current = activity;
  });
  useEffect(() => {
    stepsRef.current = steps;
  });
  useEffect(() => {
    cliRef.current = cli;
  });
  useEffect(() => {
    meetingRef.current = meeting;
  });
  useEffect(() => {
    sessionDirRef.current = sessionDir;
  });

  // 검증 잠금 시작/해제 — 신호 유실(스킬 크래시·PTY 사망) 대비 타임아웃 안전망 포함.
  const endVerifying = useCallback(() => {
    if (verifyTimerRef.current != null) {
      clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = null;
    }
    setIsVerifying(false);
  }, []);
  const beginVerifying = useCallback(() => {
    if (verifyTimerRef.current != null) clearTimeout(verifyTimerRef.current);
    setIsVerifying(true);
    verifyTimerRef.current = window.setTimeout(() => {
      verifyTimerRef.current = null;
      setIsVerifying(false);
    }, VERIFY_LOCK_TIMEOUT_MS);
  }, []);

  // Notes(회의록 탭)의 편집 모드 보고 — 편집 중 보류된 범용 refresh를 종료 시점에 반영.
  const setNotesEditing = useCallback((editing: boolean) => {
    notesEditingRef.current = editing;
    if (!editing && pendingRefreshRef.current) {
      pendingRefreshRef.current = false;
      setRefreshKey((k) => k + 1);
    }
  }, []);

  // Processing(전사·화자분리) 진입 시 로그인 유효성 체크를 병렬 발사 — completeProcessing이 파이프라인
  // 완료 후 이 결과만 await하므로 스폰 직전 대기가 없다. mlx는 auth 불필요라 제외.
  useEffect(() => {
    if (activity === Activity.Processing && cli !== "mlx") {
      authCheckRef.current = invoke<boolean>("cmd_is_cli_authed", { cli }).catch(() => true);
    }
  }, [activity, cli]);

  // Rust 녹음 상태 동기화 (window close 시 prevent_close 결정)
  useEffect(() => {
    invoke<void>("cmd_set_recording", { recording: activity === Activity.Recording }).catch(
      () => {}
    );
  }, [activity]);

  // OSC 7777 신호:
  //   refresh        — SessionViewer 재로드
  //   phase_step_done — Phase 내 단계 종료 (예: phase1의 1·2단계 완료 = 후보정 종료)
  //   phase_done     — phase1·phase2 전체 종료
  // PTY는 phase_done에서도 살려둠 (사용자가 검토 중 추가 질문 가능).
  // 사용자 Esc 중단·LLM 흐름 이탈은 Claude hook으로 잡을 수 없음 (Stop hook은 정상 turn 종료에만
  // 발동, 별도 interrupt hook 없음). 그 케이스는 사이드바 "응답이 없나요? 상태 초기화" 안전망이 처리.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("app:signal", (event) => {
      try {
        const signal = JSON.parse(event.payload) as { type: string; step?: string; msg?: string };
        if (signal.type === "refresh") {
          // 회의록 편집 중의 전체 remount는 미저장 편집을 날리므로 보류 — 편집 종료 시 반영.
          if (notesEditingRef.current) pendingRefreshRef.current = true;
          else setRefreshKey((k) => k + 1);
        } else if (signal.type === "phase_error") {
          // 로컬 LLM(mlx) 등이 작업 중 실패 신호. 진행 상태를 해제해 UI가 멈추지 않게 하고 알림.
          // 배너도 가드 안 — 이미 Idle(사용자 중단·다른 경로가 선처리)이면 늦게 온 신호에
          // 배너만 또 띄우지 않는다 (상태 전환과 알림을 항상 함께).
          const prev = activityRef.current;
          endVerifying(); // 검증 중 에러 신호 — 잠금이 고착되지 않게 함께 해제.
          if (prev === Activity.Correcting || prev === Activity.Composing) {
            setActivity(Activity.Idle);
            setCompletedActivity(null);
            showTabBanner(`작업을 완료하지 못했어요${signal.msg ? `\n${signal.msg}` : ""}`);
            // 배너는 5초 뒤 사라지므로 자리를 비운 사용자용 OS 알림 병행
            // (파이프라인 실패 알림(SessionScreen)과 동일한 대칭).
            void sendNotification(
              "Junmit — 회의록 작성 실패",
              signal.msg || "회의록 작성을 완료하지 못했어요. 앱에서 다시 시도해주세요."
            );
            void track("meeting_failed", { cli: cliRef.current });
          }
        } else if (signal.type === "phase_step_done") {
          // Phase 내 sub-step 종료. 현재는 phase1의 "correct"만 — 1단계(화자 라벨 교정·이름
          // 매칭·전사 텍스트 교정) 완료 → 회의록 작성 전이. 이 시점부터 매핑 파일을 쓰는 주체가
          // 없으므로 화자 편집 잠금도 풀린다(isEditLocked). SessionViewer가 새 파일
          // (transcript_corrected.txt) 가용성 재체크하도록 refreshKey++ + 전사본 탭 자동 이동.
          const prev = activityRef.current;
          if (signal.step === "correct" && prev === Activity.Correcting) {
            setSteps((s) => ({ ...s, corrected: true }));
            setActivity(Activity.Composing);
            setRefreshKey((k) => k + 1);
            setFocusSubtab("transcript");
            // 배너 문구는 meeting.json 기반 분기 — AI 다듬기 OFF도 같은 신호를 보내므로
            // (상태 전이·잠금 해제 공용) "교정 완료"라고 하면 안 한 작업을 했다고 말하게 된다.
            const dir = sessionDirRef.current;
            if (dir) {
              void loadMeetingMeta(dir).then((meta) => {
                if (sessionDirRef.current !== dir) return;
                showTabBanner(
                  meta?.ai_polish === false
                    ? "회의록 작성을 시작했어요\n전사본에서 화자 이름을 확인하고 수정할 수 있어요"
                    : "전사 교정 완료\n전사본에서 화자 이름을 확인하고 수정할 수 있어요"
                );
              });
            }
          } else if (signal.step === "verify") {
            // 자기검증 종료(스킬이 결과 무관 항상 전송, phase_done 이후 Idle에서 도착) —
            // 편집 잠금 해제 + 회의록 탭(본문·영수증 칩)만 재로드. 전체 remount(refreshKey) 대신
            // 스코프 키를 쓰지만, 이 시점이 진짜 완료이므로 회의록 탭 자동 이동 + 완성 배너는
            // 여기서 낸다(phase_done의 이동을 미룬 것 — 검증 중 매핑 작업을 끊지 않기 위함).
            endVerifying();
            setNotesRefreshKey((k) => k + 1);
            setFocusSubtab("notes");
            showTabBanner("회의록 완성\n검증까지 마쳤어요. 내용을 검토해주세요");
          }
        } else if (signal.type === "phase_done") {
          // 활동성이 Correcting/Composing이 아닐 땐 신호 무시 — 의도치 않은 도착 방어.
          // 정상 완료 신호이므로 completedActivity set → WorkArea가 "✓ 완료" 띠 노출.
          // SessionViewer refreshKey++로 새 파일 가용성 재체크. Composing 완료는 회의록 탭 자동 이동.
          const prev = activityRef.current;
          if (prev === Activity.Correcting || prev === Activity.Composing) {
            // 교정 신호 누락 케이스 방어 — corrected까지 함께 true로 보정. 단 mlx는 correct 단계가
            // 없어 corrected가 원래 false다(교정본 있는 재작성이면 이미 true) — 여기서 강제하면
            // 완료 순간 사이드바에 "✓ AI 다듬기"가 잠깐 뜬다. 에이전트 경로에서만 보정한다.
            const forceCorrected = cliHasAgent(cliRef.current);
            setSteps((s) => ({
              ...s,
              corrected: forceCorrected || s.corrected,
              notes_written: true,
            }));
            setActivity(Activity.Idle);
            setCompletedActivity(prev);
            setRefreshKey((k) => k + 1);
            void track("meeting_generated", {
              cli: cliRef.current,
              meeting_type: meetingTypeCategory(meetingRef.current?.meetingType),
            });
            // 에이전트 경로는 공개 직후 자기검증(6단계)이 이어진다 — verify 신호까지 회의록 본문
            // 편집·유형 변경을 잠그고 헤더·사이드바를 "검증 중"으로 표시. phase_done 시점에
            // **낙관적으로 시작**해("완료" 표기가 한 프레임 새는 것 방지) meeting.json·회의록 존재를
            // 읽어 비대상이면 즉시 해제 — 검증 OFF(notes_verification false)·무발화 조기 종료(회의록
            // 없음, 검증도 안 돎). 판정은 meeting.json이 진실(컨텍스트 Meeting은 옛 세션 재작성에서
            // notesVerification 부재).
            //
            // 회의록 탭 자동 이동·완성 배너도 검증 여부에 따라 갈린다 — 검증이 이어지면 이동을
            // verify 신호(진짜 완료)로 미루고, 사용자가 교정 완료 때 이동된 전사본 탭에서 화자
            // 매핑을 이어가게 둔다(탭은 열려 있어 원하면 초안 열람 가능). 알림·완료 띠와 동일 원칙:
            // "완료 신호는 전부 검증 종료 시점에".
            const dir = sessionDirRef.current;
            if (dir && cliHasAgent(cliRef.current)) {
              beginVerifying();
              void Promise.all([loadMeetingMeta(dir), loadMeetingNotesMd(dir)]).then(
                ([meta, notes]) => {
                  if (sessionDirRef.current !== dir) return;
                  if (notes == null) {
                    // 무발화 조기 종료 — 회의록이 없으니 이동·배너 없이 잠금만 해제.
                    endVerifying();
                    return;
                  }
                  if (meta?.notes_verification === false) {
                    endVerifying();
                    setFocusSubtab("notes");
                    showTabBanner("회의록 초안 완성\n내용을 검토하고 화자 매핑을 진행해주세요");
                  } else {
                    showTabBanner(
                      "AI가 회의록을 검증하고 있어요\n그동안 전사본에서 화자 이름을 확인해주세요"
                    );
                  }
                }
              );
            } else {
              // mlx(로컬) — 검증 단계가 없어 이 시점이 곧 완료.
              // "이 회의에 다듬기가 있었나"는 교정본 존재가 말해준다 — 로컬 경로는 교정본을 만들지
              // 않으니, 있으면 에이전트가 남긴 것이고 없으면 다듬기가 없던 회의다. 그 사실을 파일에
              // 반영해 기록 카드(파일만 봄)를 맞춘다. "쓸지 말지"가 아니라 "사실대로 쓰기"라, 옛
              // 빌드가 잘못 남긴 false도 되돌린다(자기교정). 시작이 아니라 완료 시점인 이유는
              // 중단·실패(phase_done 미도착)가 이 기록을 건드리지 않게 하기 위함. 쓰기 뒤 재로드.
              if (dir) {
                void loadCorrectedTranscript(dir).then((corrected) => {
                  if (sessionDirRef.current !== dir) return;
                  void updateMeetingMeta(dir, { ai_polish: corrected != null })
                    .then(() => {
                      // 쓰기 사이 세션을 옮겼으면 남의 화면을 재로드시키지 않는다.
                      if (sessionDirRef.current === dir) setRefreshKey((k) => k + 1);
                    })
                    .catch(() => {});
                });
              }
              setFocusSubtab("notes");
              showTabBanner("회의록 초안 완성\n내용을 검토하고 화자 매핑을 진행해주세요");
            }
          }
        }
      } catch {}
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // headless 스트림 소비 — 의미 해석은 parseHeadlessLine 단일 지점. 여기선 둘만:
  // ① init의 세션 식별(cli + session_id)을 세션 파일(agent_session.json)로 보존 — /assist
  //    이어가기 재료. 앱 재시작·옛 회의 재열기에도 이어가기가 살도록 메모리가 아닌 세션
  //    디렉토리에 둔다.
  // ② 최종 result를 ref 보관 — runHeadlessMeeting 실패 배너에 에러 원문 병기.
  // 진행 표시는 AgentProgressPanel이 같은 이벤트를 별도 구독(관심사 분리).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("headless:event", (event) => {
      for (const ev of parseHeadlessLine(event.payload)) {
        if (ev.kind === "init") {
          const dir = sessionDirRef.current;
          if (dir) void writeAgentSession(dir, { cli: ev.cli, sessionId: ev.sessionId });
        } else if (ev.kind === "result") {
          headlessResultRef.current = { isError: ev.isError, text: ev.text };
        }
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 환경
  const setAppDir = useCallback((dir: string) => setAppDirState(dir), []);
  const setSignalDir = useCallback((dir: string) => setSignalDirState(dir), []);
  const setCli = useCallback((c: Cli) => setCliState(c), []);

  // 녹음 취소
  const setCancelled = useCallback((v: boolean) => {
    cancelledRef.current = v;
  }, []);
  const isCancelled = useCallback(() => cancelledRef.current, []);

  // ─── 화면 전환 (entry transition) ────────────────────────
  //
  // PTY는 전역 싱글톤 + spawn 시점 APP_SESSION_DIR 박혀있음. 회의 컨텍스트 바뀔 때 옛 회의의
  // PTY가 잔존하면 새 회의 사이드바 액션(Tier 1 stdin write)이 옛 디렉토리에 적용되는 버그.
  // 새 회의 진입 후의 액션은 *새 PTY를 trigger*하므로 자동 안전. kill은 idempotent — 무해.
  const startNewMeeting = useCallback(
    (m: Meeting) => {
      cancelledRef.current = false;
      // PTY·로컬(mlx)·headless(claude -p) 잔존 작업 일괄 중단 — 옛 회의 프로세스가 새 컨텍스트의
      // 신호를 오염시키므로(phase_done/notify에 세션 식별 없음). 없으면 각각 no-op.
      void cancelMeetingWork();
      setHeadlessActive(false);
      setMeeting(m);
      setSessionDir(null);
      setSteps(EMPTY_STEPS);
      setSpawnRequest(null);
      setCurrentStepId(null);
      setActivity(Activity.Recording);
      setDrawerOpen(false);
      setCompletedActivity(null);
      setFocusSubtab(null);
      setTranscriptFocusLine(null);
      setLoginExpiredCli(null);
      // 검증·탭·편집 보류는 세션 스코프 상태 — 새 회의로 새지 않게 정리 (PTY kill로 검증도 죽음).
      endVerifying();
      setViewerTab(null);
      notesEditingRef.current = false;
      pendingRefreshRef.current = false;
    },
    [endVerifying]
  );

  const openExistingMeeting = useCallback(
    (s: { title: string; path: string; steps: SessionSteps }) => {
      void cancelMeetingWork();
      setHeadlessActive(false);
      setMeeting({ title: s.title, attendees: [] });
      setSessionDir(s.path);
      setSteps(s.steps);
      setSpawnRequest(null);
      setCurrentStepId(null);
      setActivity(Activity.Idle);
      setDrawerOpen(false);
      setCompletedActivity(null);
      setFocusSubtab(null);
      // 미소비 라인 이동 요청이 새 세션으로 새지 않게 (1회성 요청의 세션 스코프 정리).
      setTranscriptFocusLine(null);
      setLoginExpiredCli(null);
      endVerifying();
      setViewerTab(null);
      notesEditingRef.current = false;
      pendingRefreshRef.current = false;
    },
    [endVerifying]
  );

  const resetSession = useCallback(() => {
    void cancelMeetingWork();
    setHeadlessActive(false);
    setMeeting(null);
    setSessionDir(null);
    setSteps(EMPTY_STEPS);
    setSpawnRequest(null);
    setCurrentStepId(null);
    setActivity(Activity.Idle);
    setDrawerOpen(false);
    setCompletedActivity(null);
    setFocusSubtab(null);
    setTranscriptFocusLine(null);
    setLoginExpiredCli(null);
    endVerifying();
    setViewerTab(null);
    notesEditingRef.current = false;
    pendingRefreshRef.current = false;
  }, [endVerifying]);

  // ─── 녹음 (RecordingScreen) ──────────────────────────────
  const markSavingStarted = useCallback(() => {
    setActivity(Activity.Saving);
  }, []);

  const finishRecording = useCallback((dir: string) => {
    setSessionDir(dir);
    setSteps(EMPTY_STEPS);
    setActivity(Activity.Processing);
  }, []);

  // ─── 처리·LLM 작업 (SessionScreen) ────────────────────────
  const enterProcessing = useCallback(() => {
    setActivity(Activity.Processing);
  }, []);

  // dev 전용: 녹음 끝난 시점으로 초기화 — 처리 산출물 삭제 후 처리 전(Idle) 상태로 복원.
  // 복원 후 "오디오 처리 시작" 버튼이 노출돼 사용자가 전사→화자분리를 다시 돌릴 수 있다.
  const resetSessionToRecording = useCallback(async () => {
    if (!sessionDir) return;
    await invoke<void>("cmd_reset_session_to_recording", { sessionPath: sessionDir });
    setSteps(EMPTY_STEPS);
    setActivity(Activity.Idle);
    setCompletedActivity(null);
    setFocusSubtab(null);
  }, [sessionDir]);

  // dev 전용: 화자분리 시점으로 초기화 — /meeting 산출물만 삭제, 전사·화자분리는 보존(재실행 없이
  // /meeting 재시도). steps는 전사·화자분리만 done으로 복원 → "회의록 작성" 버튼 노출.
  const resetSessionToDiarized = useCallback(async () => {
    if (!sessionDir) return;
    await invoke<void>("cmd_reset_session_to_diarized", { sessionPath: sessionDir });
    setSteps({ ...EMPTY_STEPS, transcribed: true, diarized: true });
    setActivity(Activity.Idle);
    setCompletedActivity(null);
    setFocusSubtab(null);
  }, [sessionDir]);

  // 로컬 AI 회의록 실행 — PTY가 아닌 Rust 서브프로세스(전사·화자분리와 같은 결). 진행 라인은
  // "local:output" 이벤트(LocalProgressPanel), 완료/실패 전환은 스크립트의 신호(phase_done/
  // phase_error → app:signal)가 담당. 이 catch는 신호 없이 죽는 경우(크래시)의 안전망 —
  // 사용자 중단(cmd_cancel_local_meeting)은 Rust가 Ok로 삼키므로 여기 안 온다.
  // 스크립트 fail()은 신호와 비0 종료를 둘 다 내는데 invoke reject(즉시)가 신호(감시 스레드
  // 500ms 폴링)보다 먼저 도착한다 — 폴링 주기보다 길게 기다렸다가 그때도 Composing이면
  // (=신호가 끝내 안 온 크래시) 안전망 발동. 신호가 왔으면 phase_error가 이미 처리했으므로 침묵.
  const runLocalMeeting = useCallback(async () => {
    if (!sessionDir) return;
    // 로컬 실행이 패널 주체 — 직전 claude headless 잔존 표시(headlessActive)가 남아 있으면
    // WorkArea가 AgentProgressPanel을 우선해 mlx 진행(local:output)이 가려진다(CLI 전환 시나리오).
    setHeadlessActive(false);
    try {
      await invoke("cmd_run_local_meeting", { sessionDir });
    } catch (e) {
      // 이중 호출 가드 거절 — 오류가 아니라 "1차 실행이 이미 돌고 있음". 여기서 리셋하면
      // 정당한 1차 실행의 Composing을 죽여 완료 신호(phase_done)까지 무시되게 만든다.
      if (String(e).includes("이미 진행 중")) return;
      await new Promise((r) => setTimeout(r, 800));
      if (activityRef.current === Activity.Composing) {
        setActivity(Activity.Idle);
        setCompletedActivity(null);
        showTabBanner(`회의록 작성을 완료하지 못했어요\n${e}`);
        // phase_error 경로와 동일하게 자리 비운 사용자용 OS 알림 병행 (신호 없는 크래시라
        // phase_error 알림과 중복될 일 없음 — 신호가 왔다면 위 가드에서 이미 Idle).
        void sendNotification("Junmit — 회의록 작성 실패", `회의록 작성을 완료하지 못했어요. ${e}`);
      }
    }
  }, [sessionDir, showTabBanner]);

  // headless 경로 판정 — claude(`claude -p`)·codex(`codex exec --json`)는 headless.
  // antigravity는 PTY 유지 — `-p`가 있지만 이벤트 스트림 부재(진행 패널에 넣을 게 없음)·
  // headless 권한 soft-deny·격리 홈 부재(전역 ~/.gemini 공유로 conversation id 추정 경합),
  // 1.1.4 실측. mlx는 애초에 별도 경로(runLocalMeeting).
  const isHeadlessMeeting = useCallback(() => {
    return cliRef.current === "claude" || cliRef.current === "codex";
  }, []);

  // headless 회의록 실행 — runLocalMeeting과 대칭(Rust 서브프로세스, 진행은 "headless:event",
  // 완료/실패 전환은 스킬의 신호 파일 → app:signal). 차이 두 가지:
  // ① 진입 시 killPty — 잔존 PTY(직전 /assist resume 등)가 headless와 동시에 세션 파일을 쓰는
  //   충돌 방지(startNewMeeting의 잔존 PTY 정리와 같은 논리). headlessActive로 패널도 전환.
  // ② resolve 후에도 작업 중이면 회수 — PTY 경로의 pty:exit 안전망 부재를 invoke resolve가
  //   대신한다(프로세스는 끝났는데 완료 신호가 유실된 케이스). 검증 중 사망은 Composing 체크에
  //   안 걸리므로 endVerifying을 함께 — 검증 단계가 없는 runLocalMeeting과 다른 지점.
  const runHeadlessMeeting = useCallback(async () => {
    if (!sessionDir) return;
    const dir = sessionDir;
    void killPty();
    // 캐스트 이유: 순수 null 대입은 TS 흐름 분석이 ref를 null로 좁혀, 아래 catch의 읽기가
    // TS 버전에 따라 never로 판정된다(tsc 6.0.3 통과·IDE 내장 TS 오류). 넓은 타입으로 대입해
    // 버전 무관하게 좁힘을 방지. 실제 값은 headless:event 리스너가 실행 중에 채운다.
    headlessResultRef.current = null as HeadlessResult | null;
    setHeadlessActive(true);
    const recoverIfStalled = (failBanner?: string) => {
      // 세션이 바뀌었으면(전환이 이미 정리) 늦게 온 회수가 새 세션을 건드리지 않게 침묵.
      if (sessionDirRef.current !== dir) return;
      endVerifying();
      if (
        activityRef.current === Activity.Correcting ||
        activityRef.current === Activity.Composing
      ) {
        setActivity(Activity.Idle);
        setCompletedActivity(null);
        setRefreshKey((k) => k + 1); // 부분 산출물이 있으면 노출
        if (failBanner) {
          showTabBanner(failBanner);
          void sendNotification("Junmit — 회의록 작성 실패", failBanner.replace("\n", " "));
          void track("meeting_failed", { cli: cliRef.current });
        } else {
          showTabBanner("작업이 끝났지만 완료 신호를 받지 못했어요\n결과를 확인해주세요");
        }
      }
    };
    try {
      await invoke("cmd_run_headless_meeting", { sessionDir: dir, cli: cliRef.current });
      // 신호 감시 폴링(500ms)보다 길게 기다렸다 그때도 작업 중이면 신호 유실 — 회수.
      await new Promise((r) => setTimeout(r, 800));
      recoverIfStalled();
    } catch (e) {
      // 이중 호출 가드 거절은 오류가 아님 — runLocalMeeting과 동일 논리.
      if (String(e).includes("이미 진행 중")) return;
      await new Promise((r) => setTimeout(r, 800));
      // 스트림의 result 에러 원문(로그인 만료·한도 소진 안내 등)이 exit code보다 유용 — 우선 병기.
      const res = headlessResultRef.current;
      const detail = res?.isError && res.text ? res.text : String(e);
      recoverIfStalled(`회의록 작성을 완료하지 못했어요\n${detail}`);
    }
  }, [sessionDir, showTabBanner, endVerifying]);

  // 전사·화자분리 모두 끝남 → Phase 1(후보정)로 진입. setSteps는 markStepDone이 단계별로 처리.
  // drawer 자동 expand — 사용자가 panel을 직접 열지 않아도 LLM 작업 시작 시 자연스럽게 노출 (Section 10).
  // 새 작업 시작이므로 옛 완료 띠 정리.
  const completeProcessing = useCallback(async () => {
    // 로컬 LLM은 교정 단계가 없고 PTY도 안 쓴다 — 바로 Composing + 서브프로세스 실행.
    if (cli === "mlx") {
      setActivity(Activity.Composing);
      setDrawerOpen(true);
      setCompletedActivity(null);
      void runLocalMeeting();
      return;
    }
    // 로그인 유효성 판정 — AI 다듬기(/meeting)가 **자동으로** 이어지는 지점. 이 몇 분간 사용자는
    // 자리를 비웠을 확률이 높아, 만료면 파이프라인 도중 raw "Login expired"로 조용히 깨진다. 스폰하지
    // 않고 Idle로 되돌린 뒤 재로그인 안내 + macOS 알림으로 복귀를 유도한다(자리 비운 사용자용 —
    // 완료/실패 알림과 같은 레일). 복귀하면 사이드바 안내 + "회의록 작성" 버튼으로 재시도.
    // 값은 Processing 진입 시 **병렬로 미리 던진** authCheckRef에서 읽어(대개 이미 resolve) 여기서
    // 대기가 없다(특히 antigravity 서버 왕복이 화자분리 뒤에 숨음). ref가 비면(예외 경로) 즉석 폴백.
    // IPC 실패는 true로 열어둔다(오탐으로 막느니 통과 — 만료면 터미널 raw 노출로 여전히 복구 가능).
    const authed = await (authCheckRef.current ??
      invoke<boolean>("cmd_is_cli_authed", { cli }).catch(() => true));
    authCheckRef.current = null;
    if (!authed) {
      setActivity(Activity.Idle);
      setDrawerOpen(false);
      setCompletedActivity(null);
      setLoginExpiredCli(cli);
      void sendNotification(
        "Junmit — 로그인이 만료됐어요",
        "회의록 작성을 시작하지 못했어요. 앱을 열어 'AI 도구 설정'에서 다시 로그인하면 이어서 작성할 수 있어요."
      );
      return;
    }
    setLoginExpiredCli(null);
    setActivity(Activity.Correcting);
    setDrawerOpen(true);
    setCompletedActivity(null);
    // headless(claude·codex) — PTY 대신 Rust 서브프로세스로 실행, 진행은
    // AgentProgressPanel. preflight는 위에서 이미 통과(경로 공통).
    if (isHeadlessMeeting()) {
      void runHeadlessMeeting();
      return;
    }
    assistStartedRef.current = false; // 새 PTY 대화 — /assist 진입 표식 초기화.
    setHeadlessActive(false);
    setSpawnRequest(buildSpawnRequest(appDir, `/meeting`, sessionDir, signalDir ?? "", cli));
  }, [appDir, sessionDir, signalDir, cli, runLocalMeeting, isHeadlessMeeting, runHeadlessMeeting]);

  // 무음("발화 없음") 감지 — transcribe 단계가 transcribe_result.json에 기록한 판정을
  // ProcessingPanel이 읽어 호출. diarize·/meeting을 건너뛰고 Idle로 귀결(가짜 회의록·토큰 낭비
  // 방지). PTY를 띄우지 않으므로 drawer는 닫고, 잔여 자동이동(focusSubtab·완료 띠)을 정리한다.
  const markNoSpeech = useCallback(() => {
    setSteps((s) => ({ ...s, no_speech: true }));
    setActivity(Activity.Idle);
    setDrawerOpen(false);
    setCompletedActivity(null);
    setFocusSubtab(null);
  }, []);

  // escape hatch — 무음 판정이 오탐일 때 사용자가 "그래도 회의록 작성하기"로 진행.
  // 마커를 no_speech:false로 덮어쓰고(재개·재시작 일관) 보존된 segments.json으로 파이프라인
  // 재개. ProcessingPanel은 Idle→Processing 재진입 시 remount되어 transcribed는 skip하고
  // diarize부터 실행한다.
  const overrideNoSpeech = useCallback(async () => {
    if (!sessionDir) return;
    await invoke<void>("cmd_write_session_file", {
      sessionPath: sessionDir,
      filename: "transcribe_result.json",
      content: '{\n  "no_speech": false\n}\n',
    }).catch(() => {});
    setSteps((s) => ({ ...s, no_speech: false }));
    setActivity(Activity.Processing);
  }, [sessionDir]);

  // Tier 1/2 스킬 호출 공통 헬퍼 — 살아있는 PTY면 stdin write(Tier 1, 대화 컨텍스트 보존),
  // 실패하거나 없으면 새 PTY spawn(Tier 2). startComposing·restartCompose·requestAi가 공유한다.
  const runSkillTier = useCallback(
    async (slash: string) => {
      const alive = await invoke<boolean>("cmd_pty_is_active").catch(() => false);
      if (alive) {
        try {
          await sendSlashCommand(slash, cli);
          return;
        } catch {
          // Tier 1 실패 → Tier 2 fallback
        }
      }
      assistStartedRef.current = false; // 새 PTY 대화 — /assist 진입 표식 초기화.
      setHeadlessActive(false); // PTY가 새 실행 주체 — 작업 패널을 터미널로 되돌린다.
      setSpawnRequest(buildSpawnRequest(appDir, slash, sessionDir, signalDir ?? "", cli));
    },
    [appDir, sessionDir, signalDir, cli]
  );

  // 사용자가 명시 시작(사이드바 Primary). corrected 여부 보고 Correcting/Composing 분기.
  // Phase 1 가이드는 transcript_corrected.txt 있으면 1단계 skip하고 회의록 단계로 직진.
  const startComposing = useCallback(async () => {
    // 로컬 LLM은 교정 단계가 없고 PTY도 안 쓴다 — 서브프로세스 실행.
    if (cli === "mlx") {
      setActivity(Activity.Composing);
      setDrawerOpen(true);
      setCompletedActivity(null);
      void runLocalMeeting();
      return;
    }
    // headless는 수동 경로도 preflight — PTY의 "만료 시 터미널 raw 노출로 복구" 표면이 없어
    // 사전 차단이 유일한 안내 경로다(아래 PTY 경로의 생략 근거가 headless엔 성립하지 않음).
    if (isHeadlessMeeting()) {
      const authed = await invoke<boolean>("cmd_is_cli_authed", { cli }).catch(() => true);
      if (!authed) {
        setLoginExpiredCli(cli);
        return;
      }
      setLoginExpiredCli(null);
      setActivity(stepsRef.current.corrected ? Activity.Composing : Activity.Correcting);
      setDrawerOpen(true);
      setCompletedActivity(null);
      void runHeadlessMeeting();
      return;
    }
    // 수동 시작은 로그인 preflight 없이 즉시 진행 — 사용자가 present하고 터미널이 보이므로, 만료면
    // 터미널에 로그인 안내가 그대로 노출돼 바로 복구 가능하다(자리 비운 자동 경로와 달리 사전 차단
    // 불필요). preflight를 넣으면 스폰 전 인증 체크가 버튼 반응·터미널 노출을 지연시킨다.
    // 재시도로 여기 왔다면(loginExpiredCli 안내 노출 중) 진행하며 안내를 걷는다 — 재로그인을 안
    // 했다면 터미널이 그 사실을 알리고, 재로그인했다면 정상 진행된다.
    setLoginExpiredCli(null);
    setActivity(stepsRef.current.corrected ? Activity.Composing : Activity.Correcting);
    setDrawerOpen(true);
    setCompletedActivity(null);
    await runSkillTier("/meeting");
  }, [runSkillTier, cli, runLocalMeeting, isHeadlessMeeting, runHeadlessMeeting]);

  // 회의 유형 변경 → 본문 백업 + meta 갱신 + 회의록 재작성 트리거. corrected는 유지.
  // 화면이 confirm 다이얼로그를 띄우고 사용자 동의 후 호출. 실패는 throw — 화면이 toast 처리.
  // Tier 1 (살아있는 PTY 활용): sendSlashCommand로 /meeting 호출 — PTY kill 안 함 (다듬기 패턴과 일관).
  // Tier 2 (없으면): 새 PTY spawn. backup 파일은 meeting 스킬이 재작성 모드 감지 신호로 사용.
  // aiPolish는 교정본 없는 재작성에서만 화면이 받아 넘긴다(undefined면 기존 값 유지). true면 스킬이
  // 1단계를 되살리므로 Composing이 아니라 Correcting으로 진입해야 correct 신호가 정상 처리된다.
  const restartCompose = useCallback(
    async (newType: string, aiPolish?: boolean) => {
      if (!sessionDir) return;
      await invoke<string | null>("cmd_backup_meeting_notes", { sessionPath: sessionDir });
      await updateMeetingMeta(
        sessionDir,
        aiPolish === undefined ? { type: newType } : { type: newType, ai_polish: aiPolish }
      );
      setSteps((s) => ({ ...s, notes_written: false }));
      setActivity(aiPolish === true ? Activity.Correcting : Activity.Composing);
      setDrawerOpen(true);
      setCompletedActivity(null);
      if (cli === "mlx") {
        void runLocalMeeting();
        return;
      }
      if (isHeadlessMeeting()) {
        void runHeadlessMeeting();
        return;
      }
      await runSkillTier("/meeting");
    },
    [sessionDir, runSkillTier, cli, runLocalMeeting, isHeadlessMeeting, runHeadlessMeeting]
  );

  const updateTitle = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      // 녹음 중에는 세션 디렉토리·meeting.json이 아직 없다(녹음 종료 시 cmd_create_session이 생성).
      // 이때는 로컬 meeting state만 갱신하면 종료 시 saveRecording이 이 title로 디렉토리·
      // meeting.json을 만들어 편집이 반영된다(정상 종료·AppShell 비상 저장 둘 다 같은 context를 읽음).
      if (!sessionDir) {
        setMeeting((prev) => (prev ? { ...prev, title: trimmed } : prev));
        return;
      }
      await updateMeetingMeta(sessionDir, { title: trimmed });
      setMeeting((prev) => (prev ? { ...prev, title: trimmed } : prev));
    },
    [sessionDir]
  );

  // 참석자 갱신 — meeting.json + context를 함께 갱신해 회의 정보 팝오버·화자 매칭·전사본이
  // 같은 목록을 보게 한다(prop 반응). 기존 세션은 openExistingMeeting이 attendees를 비워두므로
  // 팝오버가 파일에서 읽어 편집하고, 이 함수가 context에 반영해 소비처를 최신화한다.
  const updateAttendees = useCallback(
    async (attendees: string[]) => {
      if (!sessionDir) return;
      await updateMeetingMeta(sessionDir, { attendees });
      setMeeting((prev) => (prev ? { ...prev, attendees } : prev));
    },
    [sessionDir]
  );

  const markPipelineSubStep = useCallback((stepId: string) => {
    if (stepId === Step.Transcribe) setCurrentStepId(Step.Transcribe);
    else if (stepId === Step.Diarize) setCurrentStepId(Step.Diarize);
  }, []);

  // ProcessingPanel이 각 단계 완료 시 호출 → 사이드바 stepper ✓ 즉시 반영.
  const markStepDone = useCallback((stepId: StepId) => {
    const stepInfo = STEPS.find((s) => s.id === stepId);
    if (!stepInfo) return;
    setSteps((s) => ({ ...s, [stepInfo.field]: true }));
  }, []);

  // PTY 명시 종료 (사용자 exit) — 정상 phase 완료는 phase_done 신호가 처리. 미완료 종료는 idle 복귀.
  const notifyPtyExit = useCallback(() => {
    // /assist resume PTY가 스폰 직후(10초 내) 죽었다면 무효 session_id(claude "No conversation
    // found" / codex "ERROR: No saved session found" 즉시 종료)로 보고 id 파일을 비운다 —
    // 다음 클릭이 fresh spawn 폴백을 타게. 정상 사용 후 종료(한참 뒤 exit)는 id를 보존해
    // 재클릭 시 다시 이어가기가 되게 한다.
    if (resumeSpawnAtRef.current != null) {
      if (Date.now() - resumeSpawnAtRef.current < 10_000) {
        const dir = sessionDirRef.current;
        if (dir) void clearAgentSession(dir);
      }
      resumeSpawnAtRef.current = null;
    }
    assistStartedRef.current = false; // PTY 대화 종료 — /assist 진입 표식도 함께 소멸.
    endVerifying(); // 검증 주체가 죽었으므로 verify 신호는 오지 않는다 — 잠금 즉시 해제.
    setActivity((prev) =>
      prev === Activity.Correcting || prev === Activity.Composing ? Activity.Idle : prev
    );
  }, [endVerifying]);

  // LLM 작업 전면 중단 — PTY(claude/codex)·로컬(mlx)·headless(claude -p) 프로세스를 함께 죽이고
  // 진행 상태·잔존 spawn 요청을 정리한다. CLI 전환처럼 "돌던 작업이 더는 유효하지 않은" 지점 공용.
  // 회의 컨텍스트(meeting/sessionDir/steps)는 건드리지 않는다 — 세션 자체는 그대로 유효.
  const abortLlmWork = useCallback(async () => {
    await cancelMeetingWork();
    assistStartedRef.current = false; // PTY도 함께 죽음 — /assist 진입 표식 초기화.
    setSpawnRequest(null);
    setHeadlessActive(false); // 실행 주체 무효화 — 다음 실행(다른 CLI 포함)이 패널을 새로 결정.
    setCurrentStepId(null);
    setCompletedActivity(null);
    endVerifying(); // PTY와 함께 검증도 죽음 — 잠금 해제.
    setActivity((prev) =>
      prev === Activity.Correcting || prev === Activity.Composing ? Activity.Idle : prev
    );
  }, [endVerifying]);

  // PTY 직접 조작 — Rust PtyManager.is_active를 진실 원천으로 invoke.
  // 호출자가 살아있는 PTY 활용(Tier 1 stdin write) vs 새 spawn(Tier 2) 분기에 사용.
  const isPtyAlive = useCallback(async () => {
    return await invoke<boolean>("cmd_pty_is_active").catch(() => false);
  }, []);

  const sendPtyInput = useCallback(async (data: string) => {
    await invoke<void>("cmd_pty_input", { data });
  }, []);

  // 새 PTY spawn — Tier 2 fallback 또는 명시 fresh start. 호출자가 슬래시 커맨드 명시 (예: `/meeting`).
  // sessionDir은 APP_SESSION_DIR env로 자동 전달 — 슬래시 커맨드 인자 공백 처리 한계 회피.
  const spawnPty = useCallback(
    (slashCommand: string) => {
      assistStartedRef.current = false; // 새 PTY 대화 — /assist 진입 표식 초기화.
      setHeadlessActive(false);
      setSpawnRequest(buildSpawnRequest(appDir, slashCommand, sessionDir, signalDir ?? "", cli));
    },
    [appDir, sessionDir, signalDir, cli]
  );

  // "AI에게 추가 요청" — 사이드바·빈 상태 UI 공통 진입점. 요청 텍스트를 **먼저 받아**(입력 선행)
  // tier별로 실어 보낸다 — AI 기동·스킬 로드·인사를 기다렸다가 입력하던 지연 제거.
  // 요청은 한 줄로 정리 — TUI stdin에서 줄바꿈은 조기 제출이 되고, 명령줄 병기도 한 줄이 안전.
  // Tier 1 (살아있는 PTY): 요청을 stdin으로 전달 — 회의록 작성 직후 PTY 잔류 상태에서
  //   사이드바 클릭한 가장 흔한 케이스. (headless 모드에선 직전 resume PTY가 이 케이스)
  //   /assist 트리거는 PTY 대화당 최초 1회만(assistStartedRef — 재트리거는 재로드·재인사 중복).
  // Tier 1.5 (headless 모드 + PTY 없음): 보존된 세션 식별(agent_session.json)로 이어가기
  //   PTY(claude --resume / codex resume)를 열어 **작성 대화 맥락을 이어서** /assist 진입 —
  //   초기 프롬프트에 요청 병기로 재개 직후 곧바로 처리. id가 없거나 무효(스폰 직후 종료 →
  //   notifyPtyExit가 파일 초기화)거나 다른 CLI로 작성된 회의(타 CLI의 id는 무효)면
  //   아래 Tier 2로 자연 폴백.
  // Tier 2 (그 외): 새 spawn — 옛 회의 다시 열기 후 시나리오. 역시 초기 프롬프트에 요청 병기.
  const requestAi = useCallback(
    async (request: string) => {
      const text = request.replace(/\s+/g, " ").trim();
      if (!text) return;
      setDrawerOpen(true);
      const alive = await invoke<boolean>("cmd_pty_is_active").catch(() => false);
      if (alive) {
        try {
          await sendAssistRequest(text, cli, assistStartedRef.current);
          assistStartedRef.current = true;
          setTerminalFocusKey((k) => k + 1); // 키보드 입력이 바로 터미널로 가게 focus 이동.
          return;
        } catch {
          // Tier 1 실패 → 아래 spawn 경로 폴백
        }
      }
      if (isHeadlessMeeting()) {
        const dir = sessionDirRef.current;
        const stored = dir ? await readAgentSession(dir) : null;
        if (stored && stored.cli === cliRef.current) {
          resumeSpawnAtRef.current = Date.now();
          assistStartedRef.current = true; // 초기 프롬프트가 /assist 진입을 겸함
          setHeadlessActive(false); // resume PTY가 패널 주체
          setSpawnRequest(
            stored.cli === "codex"
              ? buildCodexResumeRequest(appDir, stored.sessionId, dir, signalDir ?? "", text)
              : buildClaudeResumeRequest(appDir, stored.sessionId, dir, signalDir ?? "", text)
          );
          setTerminalFocusKey((k) => k + 1); // 키보드 입력이 바로 터미널로 가게 focus 이동.
          return;
        }
      }
      assistStartedRef.current = true; // 초기 프롬프트가 /assist 진입을 겸함
      setHeadlessActive(false); // PTY가 새 실행 주체 — 작업 패널을 터미널로 되돌린다.
      setSpawnRequest(buildSpawnRequest(appDir, "/assist", sessionDir, signalDir ?? "", cli, text));
      setTerminalFocusKey((k) => k + 1); // 키보드 입력이 바로 터미널로 가게 focus 이동.
    },
    [isHeadlessMeeting, appDir, sessionDir, signalDir, cli]
  );

  // ─── Claude 작업 패널 (drawer) action ──────────────────────
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  // panel close 시 "✓ 완료" 띠도 함께 정리 — 둘은 panel UX 단위.
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setCompletedActivity(null);
  }, []);
  // WorkArea 우측 끝의 absolute 토글 버튼이 한 핸들러로 받기 위한 helper.
  const toggleDrawer = useCallback(() => {
    setDrawerOpen((d) => {
      if (d) setCompletedActivity(null); // 닫을 때 띠 정리
      return !d;
    });
  }, []);

  // 사용자가 SessionViewer 탭을 직접 클릭한 경우 — 다음 단계 완료 전까지 사용자 선택 유지.
  const clearFocusSubtab = useCallback(() => setFocusSubtab(null), []);

  // 검증 영수증 근거(L{n}) 클릭 → 전사본 탭 전환 + 해당 라인 스크롤 요청.
  const requestTranscriptLine = useCallback((line: number) => {
    setFocusSubtab("transcript");
    setTranscriptFocusLine(line);
  }, []);
  const clearTranscriptFocusLine = useCallback(() => setTranscriptFocusLine(null), []);
  const clearLoginExpired = useCallback(() => setLoginExpiredCli(null), []);

  const value = useMemo<SessionContextValue>(
    () => ({
      meeting,
      sessionDir,
      steps,
      activity,
      // 화자 매핑을 쓰는 마지막 주체는 1단계 화자 작업 — corrected(phase_step_done "correct")부터
      // 편집 허용. mlx는 correct 단계가 없어 corrected=false인 Composing 내내 잠금 유지(의도).
      isEditLocked:
        (activity === Activity.Correcting || activity === Activity.Composing) && !steps.corrected,
      currentStepId,
      spawnRequest,
      appDir,
      signalDir,
      cli,
      refreshKey,
      headlessActive,
      setAppDir,
      setSignalDir,
      setCli,
      setCancelled,
      isCancelled,
      activityRef,
      drawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      completedActivity,
      focusSubtab,
      clearFocusSubtab,
      transcriptFocusLine,
      requestTranscriptLine,
      clearTranscriptFocusLine,
      isVerifying,
      notesRefreshKey,
      viewerTab,
      setViewerTab,
      setNotesEditing,
      loginExpiredCli,
      clearLoginExpired,
      tabBanner,
      dismissTabBanner,
      startNewMeeting,
      openExistingMeeting,
      resetSession,
      markSavingStarted,
      finishRecording,
      enterProcessing,
      resetSessionToRecording,
      resetSessionToDiarized,
      completeProcessing,
      markNoSpeech,
      overrideNoSpeech,
      startComposing,
      restartCompose,
      updateTitle,
      updateAttendees,
      markPipelineSubStep,
      markStepDone,
      notifyPtyExit,
      abortLlmWork,
      isPtyAlive,
      sendPtyInput,
      spawnPty,
      requestAi,
      terminalFocusKey,
    }),
    [
      meeting,
      sessionDir,
      steps,
      activity,
      currentStepId,
      spawnRequest,
      appDir,
      signalDir,
      cli,
      refreshKey,
      headlessActive,
      setAppDir,
      setSignalDir,
      setCli,
      setCancelled,
      isCancelled,
      drawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      completedActivity,
      focusSubtab,
      clearFocusSubtab,
      transcriptFocusLine,
      requestTranscriptLine,
      clearTranscriptFocusLine,
      isVerifying,
      notesRefreshKey,
      viewerTab,
      setViewerTab,
      setNotesEditing,
      loginExpiredCli,
      clearLoginExpired,
      tabBanner,
      dismissTabBanner,
      startNewMeeting,
      openExistingMeeting,
      resetSession,
      markSavingStarted,
      finishRecording,
      enterProcessing,
      resetSessionToRecording,
      resetSessionToDiarized,
      completeProcessing,
      markNoSpeech,
      overrideNoSpeech,
      startComposing,
      restartCompose,
      updateTitle,
      updateAttendees,
      markPipelineSubStep,
      markStepDone,
      notifyPtyExit,
      abortLlmWork,
      isPtyAlive,
      sendPtyInput,
      spawnPty,
      requestAi,
      terminalFocusKey,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
