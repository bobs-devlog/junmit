import type { Cli, SpawnRequest } from "@/types";
import { AGY_BIN_SH, APP_DATA_DIR_SH, CLAUDE_CONFIG_DIR_SH, CODEX_HOME_SH } from "@/utils/paths";

// PTY 명령 빌더 — SessionContext(회의 흐름)와 회의 유형 화면(useTemplateSession)이 공유.
// slashCommand는 호출자가 완전한 형태로 전달 (예: "/meeting", "/template").
//
// CLI별 차이는 "exec 명령 꼬리"로만 좁힌다 (공유 최대화):
//   - 공유: env 주입(APP_SESSION_DIR/APP_SIGNAL_DIR) + cd appDir. 신호·미리보기·저장 흐름은 CLI 무관.
//   - claude: cwd의 .claude/skills + CLAUDE.md 자동 로드, 슬래시 커맨드로 스킬 트리거.
//   - codex : cwd의 .agents/skills + AGENTS.md 자동 로드(gen-agent-skills.sh가 생성), 자연어로 스킬 트리거.
//             샌드박스가 cwd 밖(app.junmit의 신호·staging)을 쓰도록 --add-dir, 자동승인 -a never.
//   - antigravity(agy): codex와 같은 .agents/skills + AGENTS.md 규약(산출물 공유), 자연어 트리거.
//             격리 홈 env가 없어 CLI 전용 env 주입 없음. -i로 초기 프롬프트 + TUI 유지.
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
  //   Rust ensure_claude_config_dir가 준비하며 .claude.json에 cwd 신뢰가 박혀 있음.
  //   인증도 이 환경 기준. 스킬·CLAUDE.md는 cwd 기반이라 무관.
  return (
    `${envPrefix(appDir, sessionDir, signalDir)} && ` +
    `exec env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_SH}" claude "${slashCommand}"`
  );
}

// 슬래시 커맨드 → 자연어 스킬 트리거 (예: "/template" → "Run the template skill.").
// codex·antigravity 공용 — 둘 다 커스텀 슬래시 커맨드가 없고 cwd의 .agents/skills를
// description 매칭(자연어)으로 트리거한다.
// 신규 spawn(buildCodexCommand/buildAntigravityCommand)과 살아있는 TUI 입력(pty.ts
// sendSlashCommand)이 같은 문구를 공유.
export function agentSkillTrigger(slashCommand: string): string {
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
  //   Rust ensure_codex_home가 생성한다. 인증도 이 home 기준.
  return (
    `${envPrefix(appDir, sessionDir, signalDir)} && ` +
    `exec env CODEX_HOME="${CODEX_HOME_SH}" codex --sandbox workspace-write --add-dir "${APP_DATA_DIR_SH}" -a never "${agentSkillTrigger(slashCommand)}"`
  );
}

// Antigravity 인터랙티브(agy TUI). cwd의 .agents/skills + AGENTS.md 자동 로드(codex와 동일
// 규약 — gen-agent-skills.sh 산출물 공유).
// - AGY_BIN_SH 절대경로 실행 — PATH 이름 `agy`는 CLI가 지워진 상태에서 동명 IDE 런처로
//   폴백돼 편집기가 뜨는 오동작이 된다(paths.ts 주석 참고). 절대경로면 명확한 실패.
// - 격리 홈 env 없음(CLAUDE_CONFIG_DIR/CODEX_HOME 대응물 부재, 실측 1.0.16) — 설정·세션
//   기록이 사용자 전역 ~/.gemini에 남는다. HOME 오버라이드는 키링 인증을 깨므로 금지.
// - --dangerously-skip-permissions: 무인 스킬 실행용 자동 승인. 단 E2E 실측: 이 플래그는
//   **메인 세션만** 자동 승인하고, 서브에이전트의 워크스페이스 밖 파일 접근은 승인 대기
//   (Blocked)로 멈춘다 — /meeting 1단계 병렬 4건이 전부 사람 승인을 기다렸다.
// - --add-dir: 그래서 codex와 동일하게 앱 데이터 디렉토리(세션·신호·staging이 있는
//   app.junmit)를 워크스페이스에 포함 — 워크스페이스 안이면 승인 대상이 아니게 된다.
//   해당 경로의 신뢰는 ensure_antigravity_trust가 미리 베이크.
// - --sandbox는 "terminal restrictions"라 스킬의 스크립트 실행(lib/*.sh)과 안 맞아 미사용.
// - -i(--prompt-interactive): 초기 프롬프트 실행 후 TUI 유지(사용자 추가 요청 가능) —
//   claude의 `claude "/meeting"`과 동일한 상호작용 모델. positional 인자는 없음(실측).
export function buildAntigravityCommand(
  appDir: string | null,
  slashCommand: string,
  sessionDir: string | null,
  signalDir: string
): string {
  return (
    `${envPrefix(appDir, sessionDir, signalDir)} && ` +
    `exec "${AGY_BIN_SH}" --dangerously-skip-permissions --add-dir "${APP_DATA_DIR_SH}" ` +
    `-i "${agentSkillTrigger(slashCommand)}"`
  );
}

// 주: 로컬 AI(mlx)는 PTY를 쓰지 않는다 — Rust cmd_run_local_meeting(일반 서브프로세스,
// 전사·화자분리와 같은 결)이 실행·스트리밍을 담당하며 SessionContext.runLocalMeeting이 호출한다.
// 결정론적 1회성 파이프라인이라 터미널 상호작용이 무의미하기 때문 (실측 후 PTY에서 전환).
// mlx는 명시적으로 throw — 조용히 claude로 폴백하면 게이팅이 새는 진입점(미래 회귀 포함)이
// 미설치 CLI를 spawn하는 막다른 길이 된다. UI 진입점은 전부 cliHasAgent로 가드돼 있어야 한다.
export function buildCommand(
  cli: Cli,
  appDir: string | null,
  slashCommand: string,
  sessionDir: string | null,
  signalDir: string
): string {
  if (cli === "mlx") {
    throw new Error("로컬 AI(mlx)는 터미널 스킬을 지원하지 않습니다 (진입점 게이팅 누락)");
  }
  // exhaustive switch — 새 Cli 값 추가 시 여기서 컴파일 에러가 나야 한다. 삼항 폴백이었다면
  // 새 백엔드가 조용히 claude로 스폰되는 무언 폴백 사고가 된다.
  switch (cli) {
    case "codex":
      return buildCodexCommand(appDir, slashCommand, sessionDir, signalDir);
    case "antigravity":
      return buildAntigravityCommand(appDir, slashCommand, sessionDir, signalDir);
    case "claude":
      return buildClaudeCommand(appDir, slashCommand, sessionDir, signalDir);
  }
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

// 임의 셸 명령을 PTY에서 실행(설치 도우미용). PTY가 로그인셸 PATH를 주입하므로
// curl/codex 등이 해석된다. bash가 명령 종료를 기다렸다 빠지므로 pty:exit가 그때 발생
// (exec를 안 쓰는 이유: 설치 명령이 `curl … | sh` 파이프라 exec와 안 맞음).
export function buildShellRequest(commandLine: string): SpawnRequest {
  return {
    command: "bash",
    args: ["-c", commandLine],
    ts: Date.now(),
  };
}
