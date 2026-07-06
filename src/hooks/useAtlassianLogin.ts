import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Cli } from "@/types";
import { buildAtlassianLoginCommand } from "@/utils/spawn";
import { killPty } from "@/utils/pty";

interface UseAtlassianLoginOptions {
  cli: Cli;
  appDir: string | null;
  // PTY 직접 조작 — 로그인 도우미 spawn + 작업 패널 expand. SessionContext가 주입(구현 비의존).
  spawnShell: (commandLine: string) => void;
  openDrawer: () => void;
  notifyPtyExit: () => void;
  // 인증 확인 후 이어갈 동작(발행 트리거) — 호출자가 주입해 로그인↔발행 순환 의존을 끊는다.
  onAuthed: () => void | Promise<void>;
  // 미인증 안내 — 필요한 info만 받는다(ISP).
  toast: { info: (message: string) => void };
}

interface UseAtlassianLogin {
  // 로그인 도우미가 작업 패널에서 진행 중인지 — 패널 라벨 표시용.
  loginActive: boolean;
  // 발행 게이트가 호출 — ref/state set + 작업 패널 expand + 로그인 도우미 spawn.
  beginLogin: () => void;
  // PTY 종료 핸들러 — 로그인 도우미 종료면 인증 재확인 후 onAuthed, 아니면 일반 종료 처리.
  handlePtyExit: () => void;
}

// Atlassian 로그인 오케스트레이션 — SessionScreen에서 분리한 응집 단위(SRP).
// 도우미 spawn → (claude는 폴링 / codex는 자가종료) → 인증 확인 → 주입된 onAuthed로 발행 재개.
// claude/codex 전용 — antigravity는 Confluence 자동 발행 미지원(추후)이라 이 흐름에 도달하지 않는다.
export default function useAtlassianLogin(opts: UseAtlassianLoginOptions): UseAtlassianLogin {
  const { cli, appDir, spawnShell, openDrawer, notifyPtyExit, onAuthed, toast } = opts;

  // state는 패널 라벨 표시용, ref는 pty:exit 콜백(stale closure)용 — 둘을 항상 함께 갱신.
  const [loginActive, setLoginActive] = useState(false);
  const loginRef = useRef(false);

  // 로그인 도우미 종료 → 인증 재확인 통과 시 발행을 이어간다. 도우미가 세션 PTY를 대체했으므로
  // 호출자의 트리거가 자연히 새 spawn으로 흐른다. 미인증(중도 포기 등)이면 안내만.
  const resumeAfterLogin = useCallback(async () => {
    const authed = await invoke<boolean>("cmd_cli_atlassian_authed", { cli }).catch(() => true);
    if (!authed) {
      toast.info("Atlassian 로그인이 확인되지 않았습니다. Confluence 등록을 다시 시도해주세요.");
      return;
    }
    await onAuthed();
  }, [cli, toast, onAuthed]);

  // claude `/mcp` 도우미는 인증이 끝나도 TUI가 계속 떠 있어(자가 종료 없음) 종료 이벤트만으로는
  // 재개가 안 된다(실사용 보고: "성공만 나오고 다음 단계가 진행이 안 됨"). 로그인 진행 중엔
  // 인증 상태를 주기 폴링해, 확인되는 즉시 도우미를 정리하고 발행을 자동으로 이어간다.
  // 도우미 kill은 의도적 종료라 pty:exit가 억제되므로(Rust killed 플래그) handlePtyExit와
  // 이중 재개될 일이 없고, 사용자가 먼저 수동 종료하면 이 effect가 정리되어 폴링이 멈춘다.
  // codex 도우미는 명령이 스스로 종료하므로 기존 pty:exit 경로로 충분(폴링 비활성).
  useEffect(() => {
    if (!loginActive || cli !== "claude") return;
    let settled = false;
    // 판정(claude mcp list)이 폴링 주기보다 느릴 때 프로세스가 누적되지 않도록 in-flight 가드.
    let inFlight = false;
    const id = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      const authed = await invoke<boolean>("cmd_cli_atlassian_authed", { cli }).catch(() => false);
      inFlight = false;
      if (settled || !authed) return;
      settled = true;
      window.clearInterval(id);
      loginRef.current = false;
      setLoginActive(false);
      await killPty();
      void onAuthed();
    }, 4000);
    return () => {
      settled = true;
      window.clearInterval(id);
    };
  }, [loginActive, cli, onAuthed]);

  const handlePtyExit = useCallback(() => {
    if (loginRef.current) {
      loginRef.current = false;
      setLoginActive(false);
      void resumeAfterLogin();
      return;
    }
    notifyPtyExit();
  }, [notifyPtyExit, resumeAfterLogin]);

  const beginLogin = useCallback(() => {
    loginRef.current = true;
    setLoginActive(true);
    openDrawer();
    spawnShell(buildAtlassianLoginCommand(cli, appDir));
  }, [openDrawer, spawnShell, cli, appDir]);

  return { loginActive, beginLogin, handlePtyExit };
}
