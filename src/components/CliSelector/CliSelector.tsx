import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import type { Cli, CliAvailability, SpawnRequest } from "@/types";
import { routeAfterCliSelected } from "@/utils/bootstrap";
import { buildShellRequest } from "@/utils/spawn";
import { CLAUDE_CONFIG_DIR_SH, CODEX_HOME_SH } from "@/utils/paths";
import { killPty } from "@/utils/pty";
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
];

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
  const [avail, setAvail] = useState<CliAvailability | null>(null);
  const [detecting, setDetecting] = useState(true);
  // CLI를 이미 선택한 적 있는지 — "사용 중" 칩 표시 가드.
  // session.cli는 미선택에도 기본 "claude"를 주므로 chosen으로 가드해야 오표시가 없다.
  const [chosen, setChosen] = useState(false);
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

  useEffect(() => {
    void detect();
    invoke<boolean>("cmd_is_cli_chosen")
      .then(setChosen)
      .catch(() => {});
  }, [detect]);

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
  const isReady = (id: Cli) => isInstalled(id) && !needsLogin(id);

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
        // 다른 CLI로 전환 시 살아있는 PTY 종료 — 구 CLI의 TUI에 새 CLI 형식의 Tier-1
        // 입력(sendSlashCommand)이 들어가는 불일치 방지.
        if (chosen) {
          await killPty();
        }
        await invoke("cmd_set_active_cli", { cli: id });
        session.setCli(id);
        const route = await routeAfterCliSelected();
        if (chosen) {
          // 설정에서의 전환 — 결과를 명시적으로 알리고 설정으로 복귀(의존성 미비면 setup 우선).
          toast.success(`AI 도구를 ${name}로 변경했습니다.`);
          navigate(route === "/setup" ? route : "/settings", { replace: true });
        } else {
          navigate(route, { replace: true });
        }
      } catch (e) {
        toast.error(`선택을 저장하지 못했습니다: ${e}`);
        setBusy(false);
      }
    },
    [busy, chosen, navigate, session, toast]
  );

  // 카드 클릭 — 준비됐으면 바로 진행, 아니면 그 도구의 설치/로그인 단계로.
  const chooseCli = (id: Cli) => {
    if (detecting || busy) return;
    if (isReady(id)) proceed(id);
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
                Junmit은 회의를 녹음·전사하고 AI가 회의록을 작성합니다. 회의록 작성에는 Claude
                또는 ChatGPT 구독 중 하나가 필요해요. 쓰시는 구독에 맞춰 하나만 고르세요.
              </p>
              <div className={styles.cards}>
                {OPTIONS.map((o) => {
                  const ready = isReady(o.id);
                  const badgeText = detecting
                    ? "확인 중…"
                    : ready
                      ? "로그인됨"
                      : !isInstalled(o.id)
                        ? "미설치"
                        : "로그인 필요";
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
                <div className={styles.ready}>준비 완료 — {setupOpt.name}로 시작할 수 있어요.</div>
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
        </div>
      </div>
    </TerminalWorkspace>
  );
}
