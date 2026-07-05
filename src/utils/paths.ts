// 앱 데이터 디렉토리 — 셸 보간형($HOME은 PTY bash가 런타임에 확장).
// PTY에 넣을 명령 문자열 조립 전용. Rust의 단일 소스(session.rs `app_data_dir()` =
// `~/Library/Application Support/` + BUNDLE_IDENTIFIER)와 같은 경로를 가리켜야 한다.
// 절대경로가 필요한 값은 이 상수가 아니라 Rust 커맨드(cmd_get_signal_dir 등)로 받는 기존 패턴 유지.
export const APP_DATA_DIR_SH = "$HOME/Library/Application Support/app.junmit";

// codex 스킬 실행 전용 CODEX_HOME — 사용자 개인 ~/.codex와 격리된 junmit 소유 home.
// Rust session.rs `codex_home()`과 동일 경로. spawn(스킬 실행)·로그인 도우미가 함께 사용.
export const CODEX_HOME_SH = `${APP_DATA_DIR_SH}/codex`;

// claude 스킬 실행 전용 CLAUDE_CONFIG_DIR — 사용자 개인 ~/.claude와 격리된 junmit 소유 환경.
// Rust session.rs `claude_config_dir()`과 동일 경로. spawn(스킬 실행)·로그인 도우미가 함께 사용.
export const CLAUDE_CONFIG_DIR_SH = `${APP_DATA_DIR_SH}/claude`;

// antigravity CLI 실행 파일 — 격리 홈 env가 없어(실측 1.0.16) 경로 상수는 이것 하나다
// (설정·MCP는 사용자 전역 ~/.gemini 고정, merge는 session.rs ensure_antigravity_mcp가 관리.
// 추후 agy가 격리 env를 제공하면 codex 패턴의 전용 상수 + ensure_*로 상향).
// PATH 이름 "agy"로 실행하지 않고 절대경로를 쓰는 이유: Antigravity IDE 런처도 동명 agy라서
// (~/.antigravity/antigravity/bin) CLI가 지워진 상태면 PATH 폴백으로 IDE가 대신 떠버린다 —
// 절대경로면 명확한 "no such file" 실패가 된다. 공식 인스톨러의 고정 설치 경로이며
// Rust session.rs `antigravity_cli_path()`와 같은 곳을 가리켜야 한다.
export const AGY_BIN_SH = "$HOME/.local/bin/agy";
