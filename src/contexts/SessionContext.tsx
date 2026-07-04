import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import type { ReactNode, RefObject } from "react";
import { Activity, Step, STEPS } from "@/constants";
import type { StepId } from "@/constants";
import type { Cli, Meeting, SessionSteps, SpawnRequest } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { updateMeetingMeta } from "@/utils/meetingMeta";
import { killPty, sendSlashCommand } from "@/utils/pty";
import { buildShellRequest, buildSpawnRequest } from "@/utils/spawn";

// 새 회의 시작·reset 시 초기 진척도. 화면이 직접 사용 가능 (예: 처리 단계 reset).
export const EMPTY_STEPS: SessionSteps = {
  transcribed: false,
  diarized: false,
  corrected: false,
  notes_written: false,
  published: false,
  no_speech: false,
};

// PTY 명령 빌더는 `@/utils/spawn`에 공유 (유형 관리 화면과 단일 소스). publish 등 신규 스킬은
// APP_SESSION_DIR env에서 sessionDir read, meeting 스킬은 기존 $ARGUMENTS 사용 (외부 bash quote가 보호).

// SessionContext는 데이터 + 모든 transition을 책임진다 (action 메소드 패턴).
// 화면은 의도만 표현 — 데이터 변경 책임은 Context에 캡슐화.
interface SessionContextValue {
  // 데이터 (read-only로 노출)
  meeting: Meeting | null;
  sessionDir: string | null;
  steps: SessionSteps;
  activity: Activity;
  // AI 분석(후보정/작성) 중이라 사용자 편집을 잠가야 하는 상태 — Correcting||Composing 파생.
  // 화자매칭·전사본·합치기 제안이 공통으로 쓴다(각자 activity 조합을 재계산하지 않도록 단일 출처).
  isEditLocked: boolean;
  currentStepId: StepId | null;
  spawnRequest: SpawnRequest | null;
  appDir: string | null;
  signalDir: string | null;
  cli: Cli;
  refreshKey: number;

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
  completeProcessing: () => void;
  // 전사 단계에서 무음("발화 없음") 감지 → diarize·회의록 건너뛰고 Idle로. PTY spawn 안 함.
  markNoSpeech: () => void;
  // "그래도 회의록 작성하기" — 무음 판정을 무효화하고 보존된 전사로 파이프라인 재개.
  overrideNoSpeech: () => Promise<void>;
  startComposing: () => Promise<void>;
  restartCompose: (newType: string) => Promise<void>;
  // meeting.json.title 갱신 + context 동기화. 빈 문자열은 거절.
  updateTitle: (title: string) => Promise<void>;
  updateAttendees: (attendees: string[]) => Promise<void>;
  markPipelineSubStep: (stepId: string) => void;
  // ProcessingPanel이 각 단계(transcribe/diarize) 완료 시 개별 호출 — stepper ✓ 즉시 반영.
  markStepDone: (stepId: StepId) => void;
  // append/skip 모드 발행 완료 마킹 — frontend 직접 처리 시 사용 (publish 스킬 미호출 케이스).
  markPublished: () => void;
  // Activity.Publishing 진입 — 발행 트리거 시 호출 (PTY 분기는 호출자 책임).
  enterPublishing: () => void;
  notifyPtyExit: () => void;
  // CLI 전환 등에서 PTY+로컬(mlx) 작업을 함께 중단하고 진행 상태를 정리 (회의 컨텍스트는 유지).
  abortLlmWork: () => Promise<void>;

  // ─── PTY 직접 조작 (Tier 1 stdin write 패턴 위해 노출) ──────
  // 살아있는 PTY가 있으면 stdin에 텍스트 그대로 write. 없으면 throw.
  // 호출자(예: 다듬기·발행)가 isPtyAlive() 먼저 확인 후 호출하는 패턴.
  isPtyAlive: () => Promise<boolean>;
  sendPtyInput: (data: string) => Promise<void>;
  // 새 PTY spawn — 외부에서 명시 spawn 트리거 (예: Tier 2 발행 시 fresh PTY).
  // 호출자가 슬래시 커맨드 명시 (예: `/publish ${sessionDir}`).
  spawnPty: (slashCommand: string) => void;
  // 임의 셸 명령을 작업 패널 PTY에서 실행 (예: 발행 게이트의 codex Atlassian 로그인 도우미).
  // 기존 PTY는 대체됨(spawn이 kill 선행). 종료 후속 처리는 화면의 onExit이 담당.
  spawnShell: (commandLine: string) => void;

  // "AI에게 추가 요청" — 사이드바·빈 상태 UI 공통 진입점. drawer expand + (PTY 죽었으면) 자유 대화 spawn.
  requestAi: () => Promise<void>;
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

  useEffect(() => {
    activityRef.current = activity;
  });
  useEffect(() => {
    stepsRef.current = steps;
  });

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
          setRefreshKey((k) => k + 1);
        } else if (signal.type === "phase_error") {
          // 로컬 LLM(mlx) 등이 작업 중 실패 신호. 진행 상태를 해제해 UI가 멈추지 않게 하고 알림.
          // 배너도 가드 안 — 이미 Idle(사용자 중단·다른 경로가 선처리)이면 늦게 온 신호에
          // 배너만 또 띄우지 않는다 (상태 전환과 알림을 항상 함께).
          const prev = activityRef.current;
          if (
            prev === Activity.Correcting ||
            prev === Activity.Composing ||
            prev === Activity.Publishing
          ) {
            setActivity(Activity.Idle);
            setCompletedActivity(null);
            showTabBanner(`작업을 완료하지 못했어요${signal.msg ? `\n${signal.msg}` : ""}`);
          }
        } else if (signal.type === "phase_step_done") {
          // Phase 내 sub-step 종료. 현재는 phase1의 "correct"만 처리 (후보정 → 회의록 작성 전이).
          // SessionViewer가 새 파일(transcript_corrected.txt) 가용성 재체크하도록 refreshKey++ +
          // 사용자에게 교정 결과를 즉시 보여주도록 전사본 탭으로 자동 이동.
          const prev = activityRef.current;
          if (signal.step === "correct" && prev === Activity.Correcting) {
            setSteps((s) => ({ ...s, corrected: true }));
            setActivity(Activity.Composing);
            setRefreshKey((k) => k + 1);
            setFocusSubtab("transcript");
            showTabBanner("전사 교정 완료\n교정된 전사본을 확인할 수 있어요");
          }
        } else if (signal.type === "phase_done") {
          // 활동성이 Correcting/Composing/Publishing이 아닐 땐 신호 무시 — 의도치 않은 도착 방어.
          // 정상 완료 신호이므로 completedActivity set → WorkArea가 "✓ 완료" 띠 노출.
          // SessionViewer refreshKey++로 새 파일 가용성 재체크. Composing 완료는 회의록 탭 자동 이동.
          // Publishing 완료는 외부 URL이라 탭 이동 불필요 (회의록 탭 그대로).
          const prev = activityRef.current;
          if (prev === Activity.Correcting || prev === Activity.Composing) {
            // 교정 신호 누락 케이스 방어 — corrected까지 함께 true로 보정.
            setSteps((s) => ({ ...s, corrected: true, notes_written: true }));
            setActivity(Activity.Idle);
            setCompletedActivity(prev);
            setRefreshKey((k) => k + 1);
            setFocusSubtab("notes");
            showTabBanner("회의록 초안 완성\n내용을 검토하고 화자 매핑을 진행해주세요");
          } else if (prev === Activity.Publishing) {
            setSteps((s) => ({ ...s, published: true }));
            setActivity(Activity.Idle);
            setCompletedActivity(prev);
            setRefreshKey((k) => k + 1);
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
  const startNewMeeting = useCallback((m: Meeting) => {
    cancelledRef.current = false;
    void killPty();
    // PTY kill과 대칭 — 로컬(mlx) 회의록 프로세스도 옛 회의 잔존 시 새 컨텍스트의 신호를
    // 오염시키므로(phase_done/notify에 세션 식별 없음) 함께 중단한다. 없으면 no-op.
    void invoke("cmd_cancel_local_meeting").catch(() => {});
    setMeeting(m);
    setSessionDir(null);
    setSteps(EMPTY_STEPS);
    setSpawnRequest(null);
    setCurrentStepId(null);
    setActivity(Activity.Recording);
    setDrawerOpen(false);
    setCompletedActivity(null);
    setFocusSubtab(null);
  }, []);

  const openExistingMeeting = useCallback(
    (s: { title: string; path: string; steps: SessionSteps }) => {
      void killPty();
      void invoke("cmd_cancel_local_meeting").catch(() => {});
      setMeeting({ title: s.title, attendees: [] });
      setSessionDir(s.path);
      setSteps(s.steps);
      setSpawnRequest(null);
      setCurrentStepId(null);
      setActivity(Activity.Idle);
      setDrawerOpen(false);
      setCompletedActivity(null);
      setFocusSubtab(null);
    },
    []
  );

  const resetSession = useCallback(() => {
    void killPty();
    void invoke("cmd_cancel_local_meeting").catch(() => {});
    setMeeting(null);
    setSessionDir(null);
    setSteps(EMPTY_STEPS);
    setSpawnRequest(null);
    setCurrentStepId(null);
    setActivity(Activity.Idle);
    setDrawerOpen(false);
    setCompletedActivity(null);
    setFocusSubtab(null);
  }, []);

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
      }
    }
  }, [sessionDir, showTabBanner]);

  // 전사·화자분리 모두 끝남 → Phase 1(후보정)로 진입. setSteps는 markStepDone이 단계별로 처리.
  // drawer 자동 expand — 사용자가 panel을 직접 열지 않아도 LLM 작업 시작 시 자연스럽게 노출 (Section 10).
  // 새 작업 시작이므로 옛 완료 띠 정리.
  const completeProcessing = useCallback(() => {
    // 로컬 LLM은 교정 단계가 없고 PTY도 안 쓴다 — 바로 Composing + 서브프로세스 실행.
    if (cli === "mlx") {
      setActivity(Activity.Composing);
      setDrawerOpen(true);
      setCompletedActivity(null);
      void runLocalMeeting();
      return;
    }
    setActivity(Activity.Correcting);
    setSpawnRequest(buildSpawnRequest(appDir, `/meeting`, sessionDir, signalDir ?? "", cli));
    setDrawerOpen(true);
    setCompletedActivity(null);
  }, [appDir, sessionDir, signalDir, cli, runLocalMeeting]);

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
    setActivity(stepsRef.current.corrected ? Activity.Composing : Activity.Correcting);
    setDrawerOpen(true);
    setCompletedActivity(null);
    await runSkillTier("/meeting");
  }, [runSkillTier, cli, runLocalMeeting]);

  // Activity.Publishing 진입 — 발행 트리거 시 호출. PTY 분기(stdin write vs spawn)는 호출자(SessionScreen) 책임.
  const enterPublishing = useCallback(() => {
    setActivity(Activity.Publishing);
    setDrawerOpen(true);
    setCompletedActivity(null);
  }, []);

  // append/skip 모드 발행 완료 — frontend 직접 처리 시 사용 (publish 스킬 미호출 케이스).
  // create 모드는 publish 스킬이 phase_done 신호 → SessionContext listener가 자동 마킹.
  const markPublished = useCallback(() => {
    setSteps((s) => ({ ...s, published: true }));
  }, []);

  // 회의 유형 변경 → 본문 백업 + meta 갱신 + 회의록 재작성 트리거. corrected는 유지.
  // 화면이 confirm 다이얼로그를 띄우고 사용자 동의 후 호출. 실패는 throw — 화면이 toast 처리.
  // Tier 1 (살아있는 PTY 활용): sendSlashCommand로 /meeting 호출 — PTY kill 안 함 (publish 패턴과 일관).
  // Tier 2 (없으면): 새 PTY spawn. backup 파일은 meeting 스킬이 재작성 모드 감지 신호로 사용.
  const restartCompose = useCallback(
    async (newType: string) => {
      if (!sessionDir) return;
      await invoke<string | null>("cmd_backup_meeting_notes", { sessionPath: sessionDir });
      await updateMeetingMeta(sessionDir, { type: newType });
      setSteps((s) => ({ ...s, notes_written: false }));
      setActivity(Activity.Composing);
      setDrawerOpen(true);
      setCompletedActivity(null);
      if (cli === "mlx") {
        void runLocalMeeting();
        return;
      }
      await runSkillTier("/meeting");
    },
    [sessionDir, runSkillTier, cli, runLocalMeeting]
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
    setActivity((prev) =>
      prev === Activity.Correcting || prev === Activity.Composing || prev === Activity.Publishing
        ? Activity.Idle
        : prev
    );
  }, []);

  // LLM 작업 전면 중단 — PTY(claude/codex)와 로컬(mlx) 프로세스를 함께 죽이고 진행 상태·
  // 잔존 spawn 요청을 정리한다. CLI 전환처럼 "돌던 작업이 더는 유효하지 않은" 지점 공용.
  // 회의 컨텍스트(meeting/sessionDir/steps)는 건드리지 않는다 — 세션 자체는 그대로 유효.
  const abortLlmWork = useCallback(async () => {
    await Promise.allSettled([killPty(), invoke("cmd_cancel_local_meeting")]);
    setSpawnRequest(null);
    setCurrentStepId(null);
    setCompletedActivity(null);
    setActivity((prev) =>
      prev === Activity.Correcting || prev === Activity.Composing || prev === Activity.Publishing
        ? Activity.Idle
        : prev
    );
  }, []);

  // PTY 직접 조작 — Rust PtyManager.is_active를 진실 원천으로 invoke.
  // 호출자가 살아있는 PTY 활용(Tier 1 stdin write) vs 새 spawn(Tier 2) 분기에 사용.
  const isPtyAlive = useCallback(async () => {
    return await invoke<boolean>("cmd_pty_is_active").catch(() => false);
  }, []);

  const sendPtyInput = useCallback(async (data: string) => {
    await invoke<void>("cmd_pty_input", { data });
  }, []);

  // 새 PTY spawn — Tier 2 fallback 또는 명시 fresh start. 호출자가 슬래시 커맨드 명시 (예: `/publish`).
  // sessionDir은 APP_SESSION_DIR env로 자동 전달 — 슬래시 커맨드 인자 공백 처리 한계 회피.
  const spawnPty = useCallback(
    (slashCommand: string) => {
      setSpawnRequest(buildSpawnRequest(appDir, slashCommand, sessionDir, signalDir ?? "", cli));
    },
    [appDir, sessionDir, signalDir, cli]
  );

  // 임의 셸 명령 spawn — CLI 세션이 아닌 짧은 도우미 명령(로그인 등)용.
  const spawnShell = useCallback((commandLine: string) => {
    setSpawnRequest(buildShellRequest(commandLine));
  }, []);

  // "AI에게 추가 요청" — 사이드바·빈 상태 UI 공통 진입점. drawer expand + /assist 스킬 호출.
  // Tier 1 (살아있는 PTY): stdin write로 /assist 호출 — 회의록 작성 직후 PTY 잔류 상태에서
  // 사이드바 클릭한 가장 흔한 케이스.
  // Tier 2 (PTY 죽음): 새 spawn — 옛 회의 다시 열기 후 시나리오.
  const requestAi = useCallback(async () => {
    setDrawerOpen(true);
    await runSkillTier("/assist");
  }, [runSkillTier]);

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

  const value = useMemo<SessionContextValue>(
    () => ({
      meeting,
      sessionDir,
      steps,
      activity,
      isEditLocked: activity === Activity.Correcting || activity === Activity.Composing,
      currentStepId,
      spawnRequest,
      appDir,
      signalDir,
      cli,
      refreshKey,
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
      markPublished,
      enterPublishing,
      notifyPtyExit,
      abortLlmWork,
      isPtyAlive,
      sendPtyInput,
      spawnPty,
      spawnShell,
      requestAi,
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
      markPublished,
      enterPublishing,
      notifyPtyExit,
      abortLlmWork,
      isPtyAlive,
      sendPtyInput,
      spawnPty,
      spawnShell,
      requestAi,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
