import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import { cliAuthedOf, cliInstalledOf } from "@/constants";
import type { Cli, CliAvailability, SpawnRequest } from "@/types";
import { routeAfterCliSelected } from "@/utils/bootstrap";
import { buildShellRequest } from "@/utils/spawn";
import TerminalWorkspace from "@/components/TerminalWorkspace";
import { OPTIONS, type CliOption, type LocalVariantId } from "./cliOptions";
import CliCards from "./CliCards";
import LocalModelSetup from "./LocalModelSetup";
import AgentCliSetup from "./AgentCliSetup";
import styles from "./CliSelector.module.css";

interface CliSelectorProps {
  /** 카드 상단 타이틀 — 온보딩은 "Junmit", 설정 페이지는 "AI 도구". */
  title: string;
  /** 빈 영역 드래그로 창 이동 — 온보딩(전체 화면)에서만 켠다. */
  dragRegion?: boolean;
}

// AI 도구 선택·설치·로그인 공용 패널 — 온보딩 게이트(SelectCliScreen, 전체 화면)와
// 설정의 AI 도구 페이지(SettingsAiToolScreen, 사이드바 유지)가 같은 로직을 공유한다.
// 이 파일은 상태 머신(감지·터미널 도우미·진행 라우팅)과 단계 분기 셸 — 각 화면의 표시는
// CliCards(1단계) / LocalModelSetup(로컬 AI) / AgentCliSetup(설치·로그인)이 담당.
// 화면들을 라우트로 나누지 않는 이유: 도우미 터미널(TerminalWorkspace)이 단계 전환을
// 넘어 살아있어야 하고(라우트 전환=PTY 사망), 감지 결과·busy·proceed를 세 화면이 공유한다.
export default function CliSelector({ title, dragRegion = false }: CliSelectorProps) {
  const navigate = useNavigate();
  const session = useSession();
  const toast = useToast();
  const [avail, setAvail] = useState<CliAvailability | null>(null);
  const [detecting, setDetecting] = useState(true);
  // CLI를 이미 선택한 적 있는지 — "사용 중" 칩 표시 가드.
  // session.cli는 미선택에도 기본 "claude"를 주므로 chosen으로 가드해야 오표시가 없다.
  const [chosen, setChosen] = useState(false);
  // 로컬 LLM(mlx) 모델 존재 여부 — 카드 배지·준비 판정용. 변형 상세(선택·설치 목록·영속
  // 선택·기기 사양)는 LocalModelSetup이 소유·조회하고, 삭제 시 onModelsChanged로 재조회.
  const [localModel, setLocalModel] = useState<boolean | null>(null);
  // 설치/로그인 단계로 들어간 대상 CLI(null이면 선택 단계).
  const [setupFor, setSetupFor] = useState<Cli | null>(null);
  // antigravity 로그인 폴링의 "지금 확인 중" 순간 표시 — 스피너 노출 여부(아래 폴링 effect가 관리).
  const [loginChecking, setLoginChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  // 우측 터미널 도우미 — 설치/로그인 명령을 앱 안에서 직접 실행(복붙 대신 통제된 환경).
  // isDone: 종료 후 fresh 감지 결과로 성공 판정 — 성공이면 터미널을 닫고 토스트로 알린다
  // (죽은 출력이 남은 패널은 비개발자에게 노이즈). 실패면 터미널을 유지해 출력(유일한
  // 진단 단서)을 보존한다.
  const [helper, setHelper] = useState<{
    spawn: SpawnRequest;
    label: string;
    isDone: (a: CliAvailability) => boolean;
    doneMsg: string;
    // 어느 CLI의 어느 단계 도우미인지 — 로그인 진행 중 안내를 해당 CLI 화면에서만 띄우는 근거.
    // helper는 화면 전환(뒤로·다른 CLI 진입)에도 정리되지 않아 존재 여부만으론 stale 판별 불가.
    cli: Cli;
    kind: "install" | "login";
  } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // 초기 상태 detecting=true → 마운트 시 동기 setState 없이 바로 감지(cascading render 회피).
  // 결과를 반환해 호출자(도우미 종료 핸들러)가 성공 판정에 재사용할 수 있게 한다.
  const detect = useCallback((): Promise<CliAvailability | null> => {
    return invoke<CliAvailability>("cmd_detect_clis")
      .then((a): CliAvailability | null => {
        setAvail(a);
        return a;
      })
      .catch(() => {
        setAvail({
          claude: false,
          claude_authed: false,
          codex: false,
          codex_authed: false,
          antigravity: false,
          antigravity_authed: false,
        });
        return null;
      })
      .finally(() => setDetecting(false));
  }, []);

  // 로컬 모델 존재 여부 조회 — 마운트와 변형 삭제 후(onModelsChanged) 재사용.
  const refreshLocalModel = useCallback(() => {
    return invoke<boolean>("cmd_check_local_model")
      .catch(() => false)
      .then(setLocalModel);
  }, []);

  useEffect(() => {
    void detect();
    invoke<boolean>("cmd_is_cli_chosen")
      .then(setChosen)
      .catch(() => {});
    void refreshLocalModel();
  }, [detect, refreshLocalModel]);

  // "다시 확인" — 이벤트 핸들러라 동기 setState 안전.
  const redetect = useCallback(() => {
    setDetecting(true);
    void detect();
  }, [detect]);

  // antigravity 로그인 도우미 폴링 — agy TUI는 로그인 후에도 스스로 안 끝나는데, 사용자에게
  // 종료 조작을 요구했더니 /logout(계정 로그아웃)을 종료 명령으로 오인하는 사고가 실측됐다.
  // 도우미가 떠 있는 동안 인증을 주기 폴링해 확인 즉시 카드를 갱신한다 — 터미널을 닫을 필요
  // 자체가 없어진다(in-flight 가드로 판정이 폴링보다 느려도 프로세스가 누적되지 않는다).
  // 자동 kill은 하지 않는다: agy는 인증이 초기 설정 마법사보다 먼저 완료되므로 확인 즉시
  // 죽이면 마법사를 중단시킨다(설정 미저장 → 다음 spawn에서 마법사 재등장 위험). 터미널은
  // 사용자가 다음 화면으로 진행하면 자연히 정리된다.
  // detect()는 detecting을 true로 만들지 않아 배지가 "확인 중…"으로 깜빡이지 않는다.
  useEffect(() => {
    // stale 가드: 다른 CLI의 도우미가 남아있는 채 agy 설정 화면에 들어온 경우 폴링 제외.
    if (helper?.kind !== "login" || helper.cli !== "antigravity" || setupFor !== "antigravity")
      return;
    if (avail?.antigravity_authed) return;
    let stopped = false;
    let inFlight = false;
    const id = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      setLoginChecking(true);
      const started = Date.now();
      const a = await detect();
      // 확인 순간에만 스피너를 보이는 정책인데, 미인증 응답은 ~0.2초에 끝나 그대로면 인지
      // 불가한 깜빡임(glitch처럼 보임)이 된다 — 최소 600ms 노출을 보장해 5초 주기의
      // 또렷한 리듬으로 만든다.
      const remain = 600 - (Date.now() - started);
      if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain));
      setLoginChecking(false);
      inFlight = false;
      if (stopped || !a) return;
      if (a.antigravity_authed) {
        stopped = true;
        window.clearInterval(id);
        toast.success("Antigravity CLI 로그인이 확인되었습니다.");
      }
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(id);
      setLoginChecking(false);
    };
  }, [helper, setupFor, avail?.antigravity_authed, detect, toast]);

  // 도우미 실행 — 우측 터미널에 설치/로그인 명령을 띄운다. helper state와 같은 필드 구성
  // (spawn만 commandLine에서 빌드) — 호출부가 필드 이름으로 읽히게 객체 인자로 받는다.
  const runHelper = useCallback(
    (config: {
      cli: Cli;
      kind: "install" | "login";
      commandLine: string;
      label: string;
      isDone: (a: CliAvailability) => boolean;
      doneMsg: string;
    }) => {
      const { commandLine, ...helperFields } = config;
      setCollapsed(false);
      setHelper({ spawn: buildShellRequest(commandLine), ...helperFields });
    },
    []
  );

  // 도우미 명령 종료(pty:exit) → 설치/로그인 상태 자동 재감지 → 성공이면 터미널 닫고 토스트.
  // (TerminalPanel이 onExit 변경 시 리스너를 재등록하므로 helper 의존성이 stale하지 않다)
  const handleHelperExit = useCallback(async () => {
    setDetecting(true);
    const a = await detect();
    if (helper && a && helper.isDone(a)) {
      setHelper(null);
      toast.success(helper.doneMsg);
    }
  }, [detect, helper, toast]);

  const isInstalled = (id: Cli) => (avail ? cliInstalledOf(avail, id) : false);
  // 인증까지 확인 → 미인증이면 로그인 유도. claude/codex는 junmit 전용 환경 기준이라 개인
  // 환경에 이미 로그인돼 있어도 별도 로그인이 필요하고(자격 미공유, 실측), antigravity는
  // 격리 환경이 없어 사용자 전역 로그인이 그대로 인정된다.
  const needsLogin = (id: Cli) => isInstalled(id) && avail != null && !cliAuthedOf(avail, id);
  // mlx는 CLI 설치/로그인이 없고 "모델 존재"가 곧 준비 완료.
  const isReady = (id: Cli) =>
    id === "mlx" ? localModel === true : isInstalled(id) && !needsLogin(id);

  // 선택한 CLI를 영속 저장하고 다음 화면으로.
  // chosen=true 진입은 설정 경로뿐(온보딩 게이트는 미선택일 때만 뜸) — 이를 컨텍스트 판별에 사용.
  const proceed = useCallback(
    async (id: Cli) => {
      if (busy) return;
      const name = OPTIONS.find((o) => o.id === id)?.name ?? id;
      // 이미 활성인 CLI 재선택 — 변경이 아니므로 스폰/전환은 하지 않는다. 단 로그인 만료로
      // 여기 온 재로그인 흐름(loginExpiredCli, 진행 중 세션 존재)이면 "이미 사용 중" 토스트로
      // 끝내면 막다른 화면이 된다 → 그 세션으로 돌려보내 "회의록 작성"으로 잇게 한다.
      // 그 외(설정 브라우징)는 기존대로 알림만 하고 머무른다(말없는 홈 이탈 방지).
      if (chosen && id === session.cli) {
        if (session.loginExpiredCli && session.sessionDir) {
          navigate("/session", { replace: true });
        } else {
          toast.info(`이미 ${name}를 사용 중입니다.`);
        }
        return;
      }
      setBusy(true);
      try {
        // 다른 CLI로 전환 시 진행 중 LLM 작업 전면 중단 — PTY(구 CLI TUI에 새 CLI 형식
        // 입력이 들어가는 불일치)와 로컬(mlx) 프로세스(잔존하면 완료 신호가 새 백엔드
        // 작업 상태를 오염) 모두. 고아 activity·잔존 spawn 요청도 함께 정리된다.
        if (chosen) {
          await session.abortLlmWork();
        }
        // 전환 영속은 라우팅 판정(cmd_check_deps가 active_cli를 읽음)보다 앞서야 한다.
        // 대신 다운로드 화면에서 설치 없이 "뒤로" 하면 이전 CLI로 복원(revertCli) —
        // 안 하면 설치도 안 한 도구가 "사용 중"으로 남는다. 온보딩(미선택)은 복원할
        // 이전 값이 없으므로 전달하지 않는다.
        const revertCli = chosen ? session.cli : undefined;
        await invoke("cmd_set_active_cli", { cli: id });
        session.setCli(id);
        const route = await routeAfterCliSelected();
        // 모델 다운로드 화면(/local-model)에서 "뒤로" 시 돌아올 곳 — 설정 전환이면 설정, 온보딩이면 백엔드 재선택.
        const returnTo = chosen ? "/settings" : "/select-cli";
        if (chosen) {
          // 설정에서의 전환 — 결과를 알리고 설정으로 복귀. 단 의존성이 더 필요하면
          // 그 화면 우선(기초 미설치→/setup, 로컬 모델만 필요→/local-model). 모두 갖춰졌으면 설정.
          // 완료 토스트는 의존성이 다 갖춰졌을 때만 — 다운로드가 남았는데 "변경했습니다"라고
          // 말하면 되돌아 나온 사용자가 전환이 확정된 걸로 오해한다.
          if (route === "/") {
            toast.success(`회의록 AI를 ${name}로 변경했습니다.`);
            navigate("/settings", { replace: true, state: { returnTo } });
          } else {
            navigate(route, { replace: true, state: { returnTo, revertCli } });
          }
        } else {
          navigate(route, { replace: true, state: { returnTo } });
        }
      } catch (e) {
        toast.error(`선택을 저장하지 못했습니다: ${e}`);
        setBusy(false);
      }
    },
    [busy, chosen, navigate, session, toast]
  );

  // 로컬 AI 진행 — 변형 선택(LocalModelSetup)이 확정한 모델을 영속 저장하고 라우팅.
  const proceedLocal = useCallback(
    async (model: LocalVariantId, variantName: string) => {
      if (busy) return;
      try {
        // 선택을 먼저 영속 — 설치 스크립트(다운로드)와 회의록 실행이 이 값을 읽는다.
        // 다운로드 없이 "뒤로" 시엔 SetupScreen이 설치된 변형으로 복원한다.
        await invoke("cmd_set_local_model", { model });
      } catch (e) {
        toast.error(`모델 선택 저장 실패: ${e}`);
        return;
      }
      // 이미 로컬 AI 사용 중 — proceed()의 "이미 사용 중" 조기 반환에 걸리므로
      // 변형 변경(다운로드 필요 여부 포함)을 여기서 직접 라우팅한다.
      // busy는 이 분기에서만 직접 관리 (proceed는 자체 busy 가드가 있어 선점 금지).
      if (chosen && session.cli === "mlx") {
        setBusy(true);
        try {
          const route = await routeAfterCliSelected();
          if (route === "/") {
            toast.success(`로컬 AI(${variantName})를 사용합니다.`);
            navigate("/settings", { replace: true });
          } else {
            navigate(route, { replace: true, state: { returnTo: "/settings" } });
          }
        } catch (e) {
          toast.error(`화면 이동에 실패했습니다: ${e}`);
          setBusy(false);
        }
        return;
      }
      await proceed("mlx");
    },
    [busy, chosen, session.cli, proceed, navigate, toast]
  );

  // 카드 상태 배지 문구 — 상태 우선순위를 조기 반환으로 서술 (중첩 삼항 지양).
  // 로컬(mlx): 조회 전 → 확인 중 / 모델 유무. CLI: 감지 전 → 확인 중, 이후 준비도 순.
  const cardBadgeText = (o: CliOption): string => {
    if (o.local) {
      if (localModel === null) return "확인 중…";
      return localModel ? "설치됨" : "다운로드 필요";
    }
    if (detecting) return "확인 중…";
    if (isReady(o.id)) return "로그인됨";
    if (!isInstalled(o.id)) return "미설치";
    return "로그인 필요";
  };

  // 카드 클릭 — 준비됐으면 바로 진행, 아니면 그 도구의 설치/로그인 단계로.
  // mlx는 준비됐어도 항상 2단계(변형 선택)로 — 설치 후 표준↔고품질을 바꿀 유일한 진입점.
  const chooseCli = (id: Cli) => {
    if (detecting || busy) return;
    if (id !== "mlx" && isReady(id)) proceed(id);
    else setSetupFor(id);
  };

  const setupOpt = OPTIONS.find((o) => o.id === setupFor) ?? null;

  return (
    <TerminalWorkspace
      spawnRequest={helper?.spawn ?? null}
      onExit={handleHelperExit}
      drawerOpen={helper != null && !collapsed}
      onToggleDrawer={() => setCollapsed((c) => !c)}
      panelLabel={helper?.label ?? "터미널"}
      showToggle={helper != null}
    >
      <div className={styles.selectScreen} data-tauri-drag-region={dragRegion || undefined}>
        <div className={styles.selectCard}>
          <h1 className="setup-title">{title}</h1>

          {setupOpt == null ? (
            /* ── 1단계: AI 도구 선택 ── */
            <CliCards
              detecting={detecting}
              busy={busy}
              activeCliId={chosen ? session.cli : null}
              isReady={isReady}
              badgeTextFor={cardBadgeText}
              onChoose={chooseCli}
            />
          ) : setupOpt.local ? (
            /* ── 2단계: 로컬 AI 모델 변형 선택 ── */
            <LocalModelSetup
              busy={busy}
              mlxActive={chosen && session.cli === "mlx"}
              onBack={() => setSetupFor(null)}
              onProceed={proceedLocal}
              onModelsChanged={() => void refreshLocalModel()}
            />
          ) : (
            /* ── 2단계: 에이전트 CLI 설치/로그인 ── */
            <AgentCliSetup
              option={setupOpt}
              installed={isInstalled(setupOpt.id)}
              needsLogin={needsLogin(setupOpt.id)}
              ready={isReady(setupOpt.id)}
              busy={busy}
              detecting={detecting}
              loginHelperActive={helper?.kind === "login" && helper.cli === setupOpt.id}
              loginChecking={loginChecking}
              onInstall={() =>
                runHelper({
                  cli: setupOpt.id,
                  kind: "install",
                  commandLine: setupOpt.installCmd,
                  label: `${setupOpt.name} 설치`,
                  isDone: (a) => cliInstalledOf(a, setupOpt.id),
                  doneMsg: `${setupOpt.name} 설치가 완료되었습니다. 이어서 로그인해주세요.`,
                })
              }
              onLogin={() =>
                runHelper({
                  cli: setupOpt.id,
                  kind: "login",
                  commandLine: setupOpt.loginCmd,
                  label: `${setupOpt.name} 로그인`,
                  isDone: (a) => cliAuthedOf(a, setupOpt.id),
                  doneMsg: `${setupOpt.name} 로그인이 확인되었습니다.`,
                })
              }
              onBack={() => setSetupFor(null)}
              onProceed={() => void proceed(setupOpt.id)}
              onRedetect={redetect}
            />
          )}
        </div>
      </div>
    </TerminalWorkspace>
  );
}
