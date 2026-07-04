import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "@/contexts/SessionContext";
import {
  LOCAL_MODEL_STANDARD,
  LOCAL_MODEL_HIGH,
  isLocalModelId,
  type LocalModelId,
} from "@/constants";
import { useToast } from "@/contexts/ToastContext";
import { useDialog } from "@/contexts/DialogContext";
import type { Cli, CliAvailability, SpawnRequest } from "@/types";
import { routeAfterCliSelected } from "@/utils/bootstrap";
import { buildShellRequest } from "@/utils/spawn";
import { CLAUDE_CONFIG_DIR_SH, CODEX_HOME_SH } from "@/utils/paths";
import TerminalWorkspace from "@/components/TerminalWorkspace";
import styles from "./CliSelector.module.css";

interface CliOption {
  id: Cli;
  name: string;
  subtitle: string;
  installCmd: string;
  loginCmd: string; // junmit 전용 환경 기준 로그인 — 스폰·감지(Rust)와 동일 경로
  loginCmdLabel: string; // 안내 문구에 표시할 명령 이름
  docsUrl: string; // 인앱 설치 실패 시 안내할 공식 설치 가이드
  // 로컬 LLM(mlx) — CLI가 아니라 앱이 모델을 다운로드해 오프라인 실행. 설치/로그인 대신
  // 준비 여부 = 모델 존재(cmd_check_local_model), 다운로드는 SetupScreen(cmd_run_install)이 담당.
  local?: boolean;
}

// 공식 native 인스톨러(curl) — brew·node·sudo 불필요, ~/.local/bin에 설치(감지 경로). npm은 node가
// 필요해 피한다. 누구나(brew 없어도) 동작하므로 brew 분기 없이 이 방식으로 통일.
// 로그인은 각 CLI의 junmit 전용 환경(개인 설정·기록과 격리) 기준 — Rust ensure_*가 detect 시
// 환경을 만들어두므로 여기선 env만 지정. 자격은 환경 간 공유되지 않아 1회 재로그인이 필요하다.
const OPTIONS: CliOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    subtitle: "Claude 구독(Pro·Max 등)을 쓰신다면 이쪽",
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
    loginCmd: `export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_SH}" && claude auth login`,
    loginCmdLabel: "claude auth login",
    docsUrl: "https://code.claude.com/docs/ko/setup",
  },
  {
    id: "codex",
    name: "Codex",
    subtitle: "ChatGPT 구독(Plus·Pro 등)을 쓰신다면 이쪽",
    installCmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    loginCmd: `export CODEX_HOME="${CODEX_HOME_SH}" && codex login`,
    loginCmdLabel: "codex login",
    docsUrl: "https://developers.openai.com/codex/cli",
  },
  {
    id: "mlx",
    name: "로컬 AI (무료)",
    subtitle: "AI 구독 없이 이 기기에서 실행 · Gemma 4 12B · 메모리 16GB+ 필요",
    installCmd: "",
    loginCmd: "",
    loginCmdLabel: "",
    docsUrl: "https://ai.google.dev/gemma",
    local: true,
  },
];

// 로컬 모델 변형 — id는 Rust(session.rs LOCAL_MODEL_*)·install.sh·local_meeting.py와 일치.
// 실행 피크 실측: 표준 ~9.4GB(16GB Mac의 Metal 상한 이내, 구글 공식 "16GB 통합 메모리" 포지셔닝과
// 일치) / 고품질 ~13GB(24GB+ 전용). recommendRam은 권장 뱃지·경고 분기 기준.
const LOCAL_VARIANTS = [
  {
    id: LOCAL_MODEL_STANDARD,
    name: "표준",
    size: "6.8GB",
    recommendRam: 16,
    // 품질 트레이드오프는 부정문 대신 비교 프레임으로 — 고품질 쪽 "더 꼼꼼하고 안정적인"이
    // 차이를 전달하고, "검토하세요"는 쓰는 시점(회의록 완성 배너)이 담당. 실측 근거는
    // memory project_local_llm_spike (표준판 recall 진동).
    desc: "대부분의 Mac에서 동작 · 더 빠르고 가벼움 · 메모리 16GB 이상",
  },
  {
    id: LOCAL_MODEL_HIGH,
    name: "고품질",
    size: "11GB",
    recommendRam: 24,
    desc: "더 꼼꼼하고 안정적인 회의록 · 메모리 24GB 이상",
  },
] as const;
type LocalVariantId = LocalModelId;

interface CliSelectorProps {
  /** 카드 상단 타이틀 — 온보딩은 "Junmit", 설정 페이지는 "AI 도구". */
  title: string;
  /** 빈 영역 드래그로 창 이동 — 온보딩(전체 화면)에서만 켠다. */
  dragRegion?: boolean;
}

// AI 도구 선택·설치·로그인 공용 패널 — 온보딩 게이트(SelectCliScreen, 전체 화면)와
// 설정의 AI 도구 페이지(SettingsAiToolScreen, 사이드바 유지)가 같은 로직을 공유한다.
// 감지·선택 영속·설치/로그인 터미널 도우미·전환 시 PTY 정리를 모두 이 컴포넌트가 소유.
export default function CliSelector({ title, dragRegion = false }: CliSelectorProps) {
  const navigate = useNavigate();
  const session = useSession();
  const toast = useToast();
  const { confirm } = useDialog();
  const [avail, setAvail] = useState<CliAvailability | null>(null);
  const [detecting, setDetecting] = useState(true);
  // CLI를 이미 선택한 적 있는지 — "사용 중" 칩 표시 가드.
  // session.cli는 미선택에도 기본 "claude"를 주므로 chosen으로 가드해야 오표시가 없다.
  const [chosen, setChosen] = useState(false);
  // 로컬 LLM(mlx) 준비 상태 — 모델 존재 여부 + 이 기기 사양(RAM·디스크 여유).
  const [localModel, setLocalModel] = useState<boolean | null>(null);
  const [capability, setCapability] = useState<{ ram_gb: number; disk_free_gb: number } | null>(
    null
  );
  // 로컬 모델 변형 선택 — null이면 RAM 기반 권장값을 따른다(24GB+ → 고품질, 그 외 표준).
  // 이미 설치된 변형이 있으면 그걸 초기 선택으로(재진입 시 기존 선택 유지).
  const [localVariant, setLocalVariant] = useState<LocalVariantId | null>(null);
  // 설치 확인된 변형 목록 — "시작"(즉시) vs "계속"(다운로드) 라벨과 미사용 변형 삭제 UI 기준.
  const [installedList, setInstalledList] = useState<LocalVariantId[]>([]);
  // 영속 선택 변형(local_model 파일) — 삭제 가드(사용 중 변형 삭제 불가) 기준.
  const [persisted, setPersisted] = useState<LocalVariantId | null>(null);
  // 설치/로그인 단계로 들어간 대상 CLI(null이면 선택 단계).
  const [setupFor, setSetupFor] = useState<Cli | null>(null);
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
        setAvail({ claude: false, claude_authed: false, codex: false, codex_authed: false });
        return null;
      })
      .finally(() => setDetecting(false));
  }, []);

  // 로컬 모델 상태 일괄 조회 — 마운트와 변형 삭제 후 재사용.
  const refreshLocalModels = useCallback(() => {
    return Promise.all([
      invoke<boolean>("cmd_check_local_model").catch(() => false),
      invoke<string[]>("cmd_list_local_models").catch(() => [] as string[]),
      invoke<string>("cmd_get_local_model").catch(() => ""),
    ]).then(([present, list, sel]) => {
      setLocalModel(present);
      const variants = list.filter(isLocalModelId);
      setInstalledList(variants);
      if (isLocalModelId(sel)) {
        setPersisted(sel);
        // 설치된 영속 선택이면 카드 초기 선택으로 이어받는다 (사용자가 이미 고른 카드는 안 덮음).
        if (variants.includes(sel)) setLocalVariant((cur) => cur ?? sel);
      }
    });
  }, []);

  useEffect(() => {
    void detect();
    invoke<boolean>("cmd_is_cli_chosen")
      .then(setChosen)
      .catch(() => {});
    void refreshLocalModels();
    invoke<{ ram_gb: number; disk_free_gb: number }>("cmd_check_local_capable")
      .then(setCapability)
      .catch(() => {});
  }, [detect, refreshLocalModels]);

  // "다시 확인" — 이벤트 핸들러라 동기 setState 안전.
  const redetect = useCallback(() => {
    setDetecting(true);
    void detect();
  }, [detect]);

  // 도우미 실행 — 우측 터미널에 설치/로그인 명령을 띄운다.
  const runHelper = useCallback(
    (
      commandLine: string,
      label: string,
      isDone: (a: CliAvailability) => boolean,
      doneMsg: string
    ) => {
      setCollapsed(false);
      setHelper({ spawn: buildShellRequest(commandLine), label, isDone, doneMsg });
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

  // 시스템 기본 브라우저로 외부 링크 열기(설치 실패 시 공식 가이드).
  const openExternal = (url: string) => {
    invoke("plugin:shell|open", { path: url }).catch(() => {});
  };

  const isInstalled = (id: Cli) => (id === "claude" ? avail?.claude : avail?.codex) ?? false;
  // 양쪽 모두 junmit 전용 환경 기준 인증까지 확인 → 미인증이면 로그인 유도. 개인 환경에 이미
  // 로그인돼 있어도 자격이 환경 간 공유되지 않으므로(실측) junmit 환경 로그인이 별도로 필요하다.
  const needsLogin = (id: Cli) =>
    isInstalled(id) && (id === "claude" ? avail?.claude_authed : avail?.codex_authed) === false;
  // mlx는 CLI 설치/로그인이 없고 "모델 존재"가 곧 준비 완료.
  const isReady = (id: Cli) =>
    id === "mlx" ? localModel === true : isInstalled(id) && !needsLogin(id);

  // 선택한 CLI를 영속 저장하고 다음 화면으로.
  // chosen=true 진입은 설정 경로뿐(온보딩 게이트는 미선택일 때만 뜸) — 이를 컨텍스트 판별에 사용.
  const proceed = useCallback(
    async (id: Cli) => {
      if (busy) return;
      const name = OPTIONS.find((o) => o.id === id)?.name ?? id;
      // 설정에서 같은 도구 재선택 — 변경이 아니므로 알림만 하고 머무른다(말없는 홈 이탈 방지).
      if (chosen && id === session.cli) {
        toast.info(`이미 ${name}를 사용 중입니다.`);
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
            <>
              <p className={styles.selectSubtitle}>
                Junmit은 회의를 녹음·전사하고 AI가 회의록을 작성합니다. Claude·ChatGPT 구독을
                쓰거나, 구독 없이 이 기기에서 도는 로컬 AI(무료)로 작성할 수 있어요. 하나만
                고르세요.
              </p>
              <div className={styles.cards}>
                {OPTIONS.map((o) => {
                  const ready = isReady(o.id);
                  const badgeText = cardBadgeText(o);
                  const isActive = chosen && o.id === session.cli;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={clsx(styles.choiceCard, isActive && styles.choiceCardActive)}
                      onClick={() => chooseCli(o.id)}
                      aria-disabled={detecting || busy}
                    >
                      <div className={styles.cardBody}>
                        <div className={styles.cardHead}>
                          <span className={styles.cardName}>
                            {o.name}
                            {isActive && (
                              <>
                                {" "}
                                <span className={styles.usingChip}>사용 중</span>
                              </>
                            )}
                          </span>
                          <span
                            className={clsx(
                              styles.badge,
                              ready ? styles.badgeOk : styles.badgeMissing
                            )}
                          >
                            {badgeText}
                          </span>
                        </div>
                        <div className={styles.cardSub}>{o.subtitle}</div>
                      </div>
                      <span className={styles.chevron} aria-hidden="true">
                        ›
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            /* ── 2단계: 선택한 도구 설치/로그인 ── */
            <>
              {setupOpt.local ? (
                /* mlx: CLI 설치/로그인 없이 모델 변형 선택 → 다음 화면에서 다운로드 */
                (() => {
                  // 권장 = RAM 기반 (24GB+ → 고품질, 그 외 표준). 선택 전이면 권장을 따른다.
                  const recommended: LocalVariantId =
                    capability && capability.ram_gb >= 24 ? LOCAL_MODEL_HIGH : LOCAL_MODEL_STANDARD;
                  const effective = localVariant ?? recommended;
                  const chosenVariant = LOCAL_VARIANTS.find((v) => v.id === effective)!;
                  // 선택 변형이 실제 설치돼 있는지 — 버튼 라벨("시작" vs "계속"=다운로드) 기준.
                  const variantReady = installedList.includes(effective);
                  // mlx가 활성 CLI일 때만 영속 선택 변형이 "사용 중" — 삭제 불가·배지 표기 기준.
                  // claude/codex 사용 중엔 로컬 모델이 전혀 안 쓰이므로 어느 변형이든 삭제 가능.
                  const mlxActive = chosen && session.cli === "mlx";
                  // 설치 여부 게이트 — 전환 중 종료로 "선택은 qat인데 미설치"가 되면
                  // 미설치 카드에 "사용 중"이 뜨는 모순 방지.
                  const inUse = (id: LocalVariantId) =>
                    mlxActive && id === persisted && installedList.includes(id);
                  const deletable = LOCAL_VARIANTS.filter(
                    (v) => installedList.includes(v.id) && !inUse(v.id)
                  );
                  const deleteVariant = async (v: (typeof LOCAL_VARIANTS)[number]) => {
                    const ok = await confirm({
                      title: `${v.name} 모델 삭제`,
                      body: `디스크에서 약 ${v.size}를 확보합니다. 다시 사용하려면 새로 내려받아야 해요.`,
                      confirmLabel: "삭제",
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await invoke("cmd_delete_local_model", { model: v.id });
                      toast.success(`${v.name} 모델을 삭제했습니다 (${v.size} 확보).`);
                      // 방금 지운 변형이 선택된 카드로 남지 않게 — refresh가 남은 설치본(또는
                      // 권장값)으로 재선택한다.
                      setLocalVariant((cur) => (cur === v.id ? null : cur));
                      void refreshLocalModels();
                    } catch (e) {
                      toast.error(`삭제하지 못했습니다: ${e}`);
                    }
                  };
                  // 디스크 필요량 ≈ 기초 엔진(~2GB) + 선택 모델 용량 + 여유
                  const diskNeed = effective === LOCAL_MODEL_HIGH ? 14 : 10;
                  const proceedLocal = async () => {
                    if (busy) return;
                    try {
                      // 선택을 먼저 영속 — 설치 스크립트(다운로드)와 회의록 실행이 이 값을 읽는다.
                      // 다운로드 없이 "뒤로" 시엔 SetupScreen이 설치된 변형으로 복원한다.
                      await invoke("cmd_set_local_model", { model: effective });
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
                          toast.success(`로컬 AI(${chosenVariant.name})를 사용합니다.`);
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
                  };
                  return (
                    <>
                      <p className={styles.selectSubtitle}>
                        이 기기에서 도는 로컬 AI(Gemma)로 회의록을 작성합니다. 구독은 필요 없고,
                        {variantReady
                          ? " 선택한 모델은 이미 설치되어 있어요."
                          : ` 모델(${chosenVariant.size})을 한 번만 내려받아요.`}{" "}
                        녹음·전사·화자 구분·회의록 작성은 모두 동일하고, Confluence 발행과 AI에게
                        추가 요청(대화로 다듬기)은 Claude·Codex에서만 지원돼요.
                      </p>
                      <div className={styles.cards}>
                        {LOCAL_VARIANTS.map((v) => {
                          const isRecommended = v.id === recommended;
                          const isActive = v.id === effective;
                          const underRam =
                            capability && capability.ram_gb > 0
                              ? capability.ram_gb < v.recommendRam
                              : false;
                          // 배지는 카드당 하나 — 사용 중(상태) > 설치됨(상태) > 메모리 부족(경고)
                          // > 권장(조언). 설치된 변형에 다운로드 조언은 무의미, 동색 병렬은 어수선.
                          let badge: { text: string; ok: boolean } | null = null;
                          if (inUse(v.id)) badge = { text: "사용 중", ok: true };
                          else if (installedList.includes(v.id))
                            badge = { text: "설치됨", ok: true };
                          else if (underRam) badge = { text: "메모리 부족", ok: false };
                          else if (isRecommended) badge = { text: "이 기기 권장", ok: true };
                          return (
                            <button
                              type="button"
                              key={v.id}
                              className={clsx(
                                styles.choiceCard,
                                isActive && styles.choiceCardActive
                              )}
                              onClick={() => setLocalVariant(v.id)}
                            >
                              <div className={styles.cardBody}>
                                <div className={styles.cardHead}>
                                  <span className={styles.cardName}>
                                    {v.name} ({v.size})
                                  </span>
                                  {badge && (
                                    <span
                                      className={clsx(
                                        styles.badge,
                                        badge.ok ? styles.badgeOk : styles.badgeMissing
                                      )}
                                    >
                                      {badge.text}
                                    </span>
                                  )}
                                </div>
                                <div className={styles.cardSub}>{v.desc}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className={styles.install}>
                        <div className={styles.installLabel}>
                          {capability ? (
                            <>
                              이 기기: 메모리 {capability.ram_gb}GB · 여유 공간{" "}
                              {capability.disk_free_gb}GB
                              {capability.ram_gb > 0 &&
                                capability.ram_gb < chosenVariant.recommendRam && (
                                  <>
                                    <br />
                                    ⚠️ 이 모델은 메모리 {chosenVariant.recommendRam}GB 이상을
                                    권장해요 — 회의록 작성이 느리거나 불안정할 수 있어요.
                                  </>
                                )}
                              {capability.disk_free_gb > 0 &&
                                capability.disk_free_gb < diskNeed && (
                                  <>
                                    <br />
                                    ⚠️ 디스크 여유가 부족할 수 있어요(엔진·모델 합계 약 {diskNeed}GB
                                    필요).
                                  </>
                                )}
                            </>
                          ) : (
                            "이 기기 사양을 확인하는 중…"
                          )}
                          {/* 미사용 변형 정리 — 갈아탄 뒤 남은 6.8~11GB를 회수할 유일한 진입점. */}
                          {deletable.map((v) => (
                            <span key={v.id}>
                              <br />
                              사용하지 않는 {v.name} 모델({v.size})이 남아 있어요.{" "}
                              <button
                                type="button"
                                className={styles.link}
                                onClick={() => void deleteVariant(v)}
                              >
                                삭제해 공간 확보
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setSetupFor(null)}
                        >
                          뒤로
                        </button>
                        <button
                          type="button"
                          className={clsx("btn btn-primary", busy && styles.btnDisabled)}
                          aria-disabled={busy}
                          onClick={proceedLocal}
                          autoFocus
                        >
                          {variantReady ? "로컬 AI로 시작" : "계속"}
                        </button>
                      </div>
                    </>
                  );
                })()
              ) : (
                <>
                  <p className={styles.selectSubtitle}>
                    {setupOpt.name}를 준비할게요. 설치하고 로그인하면 바로 시작됩니다.
                  </p>

                  {!isInstalled(setupOpt.id) ? (
                    <div className={styles.install}>
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={() =>
                          runHelper(
                            setupOpt.installCmd,
                            `${setupOpt.name} 설치`,
                            (a) => (setupOpt.id === "claude" ? a.claude : a.codex),
                            `${setupOpt.name} 설치가 완료되었습니다. 이어서 로그인해주세요.`
                          )
                        }
                      >
                        설치하기
                      </button>
                      <div className={styles.installLabel}>
                        공식 인스톨러를 우측 터미널에서 실행 · 끝나면 자동 확인 (brew·node 불필요)
                      </div>
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => openExternal(setupOpt.docsUrl)}
                      >
                        설치가 안 되면 공식 가이드 →
                      </button>
                    </div>
                  ) : needsLogin(setupOpt.id) ? (
                    <div className={styles.install}>
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={() =>
                          runHelper(
                            setupOpt.loginCmd,
                            `${setupOpt.name} 로그인`,
                            (a) => (setupOpt.id === "claude" ? a.claude_authed : a.codex_authed),
                            `${setupOpt.name} 로그인이 확인되었습니다.`
                          )
                        }
                      >
                        로그인하기
                      </button>
                      <div className={styles.installLabel}>
                        우측 터미널에서{" "}
                        <code className={styles.installCmd}>{setupOpt.loginCmdLabel}</code> 실행 ·
                        브라우저로 로그인하면 자동 확인
                        <br />
                        Junmit 전용 환경에 로그인합니다 — 개인 {setupOpt.name} 설정·기록과 분리되어,
                        이미 로그인하셨더라도 1회 더 필요합니다.
                      </div>
                    </div>
                  ) : (
                    <div className={styles.ready}>
                      준비 완료 — {setupOpt.name}로 시작할 수 있어요.
                    </div>
                  )}

                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setSetupFor(null)}
                    >
                      뒤로
                    </button>
                    {isReady(setupOpt.id) ? (
                      <button
                        type="button"
                        className={clsx("btn btn-primary", busy && styles.btnDisabled)}
                        aria-disabled={busy}
                        onClick={() => proceed(setupOpt.id)}
                        // 준비 완료로 전환되며 새로 마운트될 때 포커스를 받아, 자동 내비게이션의
                        // 위험(flaky 감지에 끌려감) 없이 Enter 한 번으로 진행 가능하게 한다.
                        autoFocus
                      >
                        {setupOpt.name}로 시작
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={clsx("btn btn-secondary", detecting && styles.btnDisabled)}
                        onClick={redetect}
                        aria-disabled={detecting}
                      >
                        다시 확인
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </TerminalWorkspace>
  );
}
