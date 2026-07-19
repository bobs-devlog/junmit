import { LOCAL_MODEL_STANDARD, LOCAL_MODEL_HIGH, type LocalModelId } from "@/constants";
import type { Cli } from "@/types";
import { AGY_BIN_SH, CLAUDE_CONFIG_DIR_SH, CODEX_HOME_SH } from "@/utils/paths";

// CliSelector 화면들이 공유하는 선택지 데이터 — 순수 설정값(컴포넌트 로직 없음).

export interface CliOption {
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
// 로그인은 claude/codex는 junmit 전용 환경(개인 설정·기록과 격리) 기준 — Rust ensure_*가 detect 시
// 환경을 만들어두므로 여기선 env만 지정. 자격은 환경 간 공유되지 않아 1회 재로그인이 필요하다.
// antigravity는 격리 환경이 없어(spawn.ts 참고) 사용자 전역 로그인을 그대로 쓴다.
export const OPTIONS: CliOption[] = [
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
    id: "antigravity",
    // "Antigravity"만 쓰면 IDE(별도 제품)와 혼동 — 공식 도구명 "Antigravity CLI"로 표기
    // (claude 카드가 "Claude"가 아닌 "Claude Code"인 것과 같은 관례).
    name: "Antigravity CLI",
    // "무료" 표현 금지 — 무료 티어는 있지만 쿼터(하루 ~20 에이전트 요청, 2026-03 기준)가
    // 회의록 파이프라인(스킬 + 병렬 sub-agent)에 부족할 수 있다. 타깃은 Google AI 구독자.
    subtitle: "Google AI 구독(Pro·Ultra 등)을 쓰신다면 이쪽 · Gemini 기반",
    installCmd: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    // agy는 로그인 서브커맨드가 없다(실측 1.0.16) — TUI 첫 실행이 곧 로그인 흐름(브라우저
    // OAuth, 시스템 키링 저장). 절대경로 실행은 동명 IDE 런처 폴백 회피(paths.ts 주석 참고).
    loginCmd: `"${AGY_BIN_SH}"`,
    loginCmdLabel: "agy",
    docsUrl: "https://antigravity.google/docs/cli/reference",
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
export const LOCAL_VARIANTS = [
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

export type LocalVariant = (typeof LOCAL_VARIANTS)[number];
export type LocalVariantId = LocalModelId;
