import type { Cli, SpawnRequest } from "@/types";
import { APP_DATA_DIR_SH, CLAUDE_CONFIG_DIR_SH, CODEX_HOME_SH } from "@/utils/paths";

// PTY 명령 빌더 — SessionContext(회의 흐름)와 회의 유형 화면(useTemplateSession)이 공유.
// slashCommand는 호출자가 완전한 형태로 전달 (예: "/meeting", "/template").
//
// CLI별 차이는 "exec 명령 꼬리"로만 좁힌다 (공유 최대화):
//   - 공유: env 주입(APP_SESSION_DIR/APP_SIGNAL_DIR) + cd appDir. 신호·미리보기·저장 흐름은 CLI 무관.
//   - claude: cwd의 .claude/skills + CLAUDE.md 자동 로드, 슬래시 커맨드로 스킬 트리거.
//   - codex : cwd의 .agents/skills + AGENTS.md 자동 로드(gen-agent-skills.sh가 생성), 자연어로 스킬 트리거.
//             샌드박스가 cwd 밖(app.junmit의 신호·staging)을 쓰도록 --add-dir, 자동승인 -a never.
//
// APP_SESSION_DIR env로 sessionDir 전달 — 슬래시 커맨드 파서가 공백 경로(예: "Application Support")를
// quote 처리 안 해서다. 유형 관리처럼 세션 없는 경우 빈 문자열(스킬이 무시).
// APP_SIGNAL_DIR — 이 앱 인스턴스 전용 신호 디렉토리. signal.sh가 비-tty(도구 실행)에서 신호 파일에 append.
// APP_DIR — 작업 루트(cd 대상, lib/·bin/이 여기 있음). 스킬이 스크립트를 `$APP_DIR/lib|bin/...` 절대경로로
//   호출하게 해 CWD 의존을 없앤다. 하네스가 "Base directory: …/skills/…"를 주입해 LLM이 cd하면 상대경로가
//   깨지던 문제(신호 누락→UI 미갱신)를 방지. 모든 Bash 호출이 이 env를 상속.

// claude/codex 공통 env + cd 프리픽스. (CLI 전용 env는 각 빌더가 exec 시점에 덧붙임)
function envPrefix(appDir: string | null, sessionDir: string | null, signalDir: string): string {
  return (
    `export PATH="$HOME/.local/bin:$PATH" ` +
    `APP_DIR="${appDir ?? ""}" APP_SESSION_DIR="${sessionDir ?? ""}" APP_SIGNAL_DIR="${signalDir}" && cd "${appDir}"`
  );
}

export function buildClaudeCommand(
  appDir: string | null,
  slashCommand: string,
  sessionDir: string | null,
  signalDir: string
): string {
  // CLAUDE_CODE_NO_FLICKER는 claude 전용 — exec env로 이 프로세스에만 주입.
  // CLAUDE_CONFIG_DIR: 사용자 개인 ~/.claude(전역 설정·세션 기록)와 격리된 junmit 전용 환경.
  //   Rust ensure_claude_config_dir가 준비하며 .claude.json에 Atlassian MCP·cwd 신뢰가 박혀 있음.
  //   인증도 이 환경 기준(CliSelector 로그인 도우미와 동일 경로). 스킬·CLAUDE.md는 cwd 기반이라 무관.
  return (
    `${envPrefix(appDir, sessionDir, signalDir)} && ` +
    `exec env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_SH}" claude "${slashCommand}"`
  );
}

// 슬래시 커맨드 → codex 자연어 스킬 트리거 (예: "/template" → "Run the template skill.").
// codex는 슬래시 커맨드가 없고 cwd의 .agents/skills를 자연어로 트리거한다.
// 신규 spawn(buildCodexCommand)과 살아있는 TUI 입력(pty.ts sendSlashCommand)이 같은 문구를 공유.
export function codexSkillTrigger(slashCommand: string): string {
  const skill = slashCommand.replace(/^\//, "");
  return `Run the ${skill} skill.`;
}

// Codex 인터랙티브(Claude와 동일하게 PTY 유지·터미널 직접 대화). cwd의 .agents/skills에서 자동 로드.
export function buildCodexCommand(
  appDir: string | null,
  slashCommand: string,
  sessionDir: string | null,
  signalDir: string
): string {
  // --add-dir: 신호 디렉토리·staging이 cwd 밖(app.junmit)이라 샌드박스 쓰기 루트로 추가. danger-full-access 회피.
  // CODEX_HOME: 사용자 개인 ~/.codex(플러그인·hooks·기록)와 격리된 junmit 전용 home.
  //   Rust ensure_codex_home가 생성하며 config.toml에 Atlassian MCP가 박혀 있음. 인증도 이 home 기준.
  return (
    `${envPrefix(appDir, sessionDir, signalDir)} && ` +
    `exec env CODEX_HOME="${CODEX_HOME_SH}" codex --sandbox workspace-write --add-dir "${APP_DATA_DIR_SH}" -a never "${codexSkillTrigger(slashCommand)}"`
  );
}

export function buildCommand(
  cli: Cli,
  appDir: string | null,
  slashCommand: string,
  sessionDir: string | null,
  signalDir: string
): string {
  return cli === "codex"
    ? buildCodexCommand(appDir, slashCommand, sessionDir, signalDir)
    : buildClaudeCommand(appDir, slashCommand, sessionDir, signalDir);
}

export function buildSpawnRequest(
  appDir: string | null,
  slashCommand: string,
  sessionDir: string | null,
  signalDir: string,
  cli: Cli = "claude"
): SpawnRequest {
  return {
    command: "bash",
    args: ["-c", buildCommand(cli, appDir, slashCommand, sessionDir, signalDir)],
    ts: Date.now(),
  };
}

// 임의 셸 명령을 PTY에서 실행(설치·로그인 도우미용). PTY가 로그인셸 PATH를 주입하므로
// curl/codex 등이 해석된다. bash가 명령 종료를 기다렸다 빠지므로 pty:exit가 그때 발생
// (exec를 안 쓰는 이유: 설치 명령이 `curl … | sh` 파이프라 exec와 안 맞음).
export function buildShellRequest(commandLine: string): SpawnRequest {
  return {
    command: "bash",
    args: ["-c", commandLine],
    ts: Date.now(),
  };
}

// Atlassian MCP 로그인 도우미 명령 — 각 CLI의 junmit 전용 환경(개인 설정과 격리)에서 OAuth.
// 완료 판정은 도우미 종료 후 cmd_cli_atlassian_authed 재확인이 담당하므로 종료 코드에는
// 의존하지 않는다(오케스트레이션은 useAtlassianLogin).
// - codex: `codex mcp login`이 인증 URL을 출력만 하고 브라우저를 열지 않으므로(실측)
//   URL 라인을 감지해 기본 브라우저로 자동 오픈. 인증이 끝나면 명령이 스스로 종료. cwd 무관.
// - claude: 외부 로그인 명령이 없어(mcp 서브커맨드에 login 부재, 실측) TUI를 "/mcp"로 띄운다.
//   TUI는 cwd를 프로젝트로 삼으므로 신뢰가 베이크된 appDir로 이동해야 신뢰 다이얼로그가 안 뜬다
//   (buildShellRequest는 cd를 안 함). TUI는 인증 후에도 스스로 안 끝나므로 인증 상태 폴링이
//   확인 즉시 도우미를 정리하고 발행을 잇는다(useAtlassianLogin의 폴링 effect).
export function buildAtlassianLoginCommand(cli: Cli, appDir: string | null): string {
  if (cli === "codex") {
    return (
      `export CODEX_HOME="${CODEX_HOME_SH}" && codex mcp login atlassian 2>&1 | ` +
      `while IFS= read -r line; do echo "$line"; case "$line" in https://*) open "$line";; esac; done`
    );
  }
  return (
    (appDir ? `cd "${appDir}" && ` : "") +
    `export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_SH}" CLAUDE_CODE_NO_FLICKER=1 && claude "/mcp"`
  );
}
