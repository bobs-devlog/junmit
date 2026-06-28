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
