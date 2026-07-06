use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::process::Command;
#[cfg(not(debug_assertions))]
use tauri::Manager;

// libNative.dylib (Swift) — EventKit/AVFoundation을 메인 앱 프로세스에서 호출
extern "C" {
    fn native_fetch_calendar_events(date_iso: *const c_char) -> *mut c_char;
    fn native_mic_permission_status() -> i32;
    fn native_request_mic_permission() -> i32;
    fn native_calendar_permission_status() -> i32;
    fn native_free_string(ptr: *mut c_char);
    // 마이크 캡처 — AVAudioEngine (네이티브). 브라우저 getUserMedia+MediaRecorder 대체.
    fn native_start_mic_capture(path: *const c_char) -> i32;
    fn native_stop_mic_capture() -> i32;
    fn native_mic_level() -> f32;
    // 시스템 오디오(원격회의 상대방 음성) 캡처 — CoreAudio Process Tap.
    // 권한 코드: 0=authorized, 1=denied, 2=not_determined.
    fn native_system_audio_permission_status() -> i32;
    fn native_request_system_audio_permission() -> i32;
    fn native_start_system_audio_capture(path: *const c_char) -> i32;
    fn native_stop_system_audio_capture() -> i32;
    fn native_system_audio_level() -> f32;
    // 녹음 중 전원 관리 — App Nap/유휴 슬립 방지 + willSleep 감지.
    fn native_begin_recording_activity();
    fn native_end_recording_activity();
    fn native_set_sleep_callback(cb: extern "C" fn());
}

/// 앱 시작 시 1회 — 시스템 willSleep 시 호출될 C 콜백을 네이티브에 등록.
pub fn set_sleep_callback(cb: extern "C" fn()) {
    unsafe { native_set_sleep_callback(cb) }
}

/// FFI가 반환한 C 문자열을 Rust로 가져오면서 즉시 해제.
fn take_ffi_string(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    unsafe {
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        native_free_string(ptr);
        Some(s)
    }
}

/// 앱 번들 identifier — tauri.conf.json의 `identifier`와 일치해야 함.
/// macOS 표준 경로(Application Support, Caches 등) 결정에 사용.
const BUNDLE_IDENTIFIER: &str = "app.junmit";

/// 사용자 데이터 디렉토리 — 모델, venv, 세션 결과물(output)이 여기 저장됨.
/// 앱 번들과 분리되어 앱 위치가 바뀌어도 보존되고, 앱 삭제 시에도 macOS는 자동 삭제하지 않음.
pub fn app_data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Application Support").join(BUNDLE_IDENTIFIER)
}

pub fn output_dir() -> PathBuf {
    app_data_dir().join("output")
}

/// 회의 유형 가이드의 단일 진실 원천. 사용자가 직접 편집하거나 새 `{name}.md`를 추가할 수 있다.
/// 첫 실행 시 시드(번들 동봉)에서 자동 복사된다.
pub fn user_templates_dir() -> PathBuf {
    app_data_dir().join("templates")
}

/// 시드 templates 위치 — 워크스페이스/번들 공통으로 `resource_dir/templates`.
/// dev/release 모두 resource_dir이 templates를 포함한 동봉 자산 디렉토리를 가리킨다
/// (dev: `<workspace>/resources/`, release: 앱 번들 `Contents/Resources/`).
pub fn seed_templates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(resource_dir(app)?.join("templates"))
}

pub fn models_dir() -> PathBuf {
    app_data_dir().join("models")
}

pub fn venv_dir() -> PathBuf {
    app_data_dir().join(".venv")
}

/// 로컬 LLM(MLX) 모델 변형 — Gemma 4 12B 2종. 사용자가 "AI 도구 선택"에서 고른다.
/// 디렉토리명은 install.sh·local_meeting.py의 매핑과 일치해야 함.
///   표준: 순수 4bit 6.8GB(실행 피크 ~9.4GB, 16GB Mac) / 고품질: 혼합 정밀도 11GB(~13GB, 24GB+).
pub const LOCAL_MODEL_STANDARD: &str = "gemma-4-12b-4bit";
pub const LOCAL_MODEL_HIGH: &str = "gemma-4-12b-qat";

fn local_model_file() -> PathBuf {
    app_data_dir().join("local_model")
}

/// 선택된 로컬 모델(디렉토리명). 미선택·손상 시 표준판.
pub fn read_local_model() -> String {
    fs::read_to_string(local_model_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s == LOCAL_MODEL_STANDARD || s == LOCAL_MODEL_HIGH)
        .unwrap_or_else(|| LOCAL_MODEL_STANDARD.to_string())
}

pub fn write_local_model(model: &str) -> Result<(), String> {
    if model != LOCAL_MODEL_STANDARD && model != LOCAL_MODEL_HIGH {
        return Err(format!("알 수 없는 로컬 모델: {model}"));
    }
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    fs::write(local_model_file(), model).map_err(|e| e.to_string())
}

/// 로컬 LLM 모델 저장 디렉토리 (install.sh가 여기에 다운로드).
pub fn local_model_dir() -> PathBuf {
    models_dir().join("mlx")
}

pub fn local_model_path() -> PathBuf {
    local_model_dir().join(read_local_model())
}

/// 로컬 LLM 모델이 설치되어 있는지 — config.json + 실제 가중치(.safetensors)가 모두 있어야 함.
/// config만 받다 만 부분 다운로드를 "설치됨"으로 오판하지 않도록 가중치 존재까지 확인한다.
/// 샤드 인덱스(model.safetensors.index.json)가 있으면 weight_map의 모든 샤드를 요구 —
/// Gemma 12B는 2샤드 구성(실측)이라 샤드 하나만 받다 만 상태를 놓치면 회의 때마다
/// 로드 실패가 반복되는데 UI엔 재다운로드 진입점이 없다. false면 /local-model로 라우팅되어
/// install.sh(snapshot_download resume)가 나머지를 이어받는다.
pub fn local_model_present() -> bool {
    model_present_at(&local_model_path())
}

/// 이름으로 지정한 변형의 설치 여부 — 설치 목록 조회·미사용 변형 삭제 UI용.
pub fn local_model_present_named(name: &str) -> bool {
    model_present_at(&local_model_dir().join(name))
}

/// 임의 변형 디렉토리에 대한 동일 판정 — 변형 복원(revert) 등 선택 외 변형 확인용.
fn model_present_at(dir: &std::path::Path) -> bool {
    if !dir.join("config.json").exists() {
        return false;
    }
    let index = dir.join("model.safetensors.index.json");
    if index.exists() {
        let Ok(txt) = std::fs::read_to_string(&index) else {
            return false;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            return false;
        };
        let Some(map) = v.get("weight_map").and_then(|m| m.as_object()) else {
            return false;
        };
        let shards: std::collections::HashSet<&str> =
            map.values().filter_map(|f| f.as_str()).collect();
        return !shards.is_empty() && shards.iter().all(|f| dir.join(f).exists());
    }
    std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.file_name().to_string_lossy().ends_with(".safetensors"))
        })
        .unwrap_or(false)
}

/// 변형 선택을 다운로드 시작 전에 되돌아갈 때의 복원 — 선택 변형이 미설치인데 다른 변형이
/// 설치돼 있으면 그쪽으로 되돌린다. 안 하면 멀쩡히 설치된 앱이 "다운로드 필요" 표시 +
/// 다음 부팅에 /local-model 강제 진입으로 남는다(선택 영속이 다운로드 확정보다 앞서는 구조 보완).
pub fn revert_local_model_if_missing() {
    if local_model_present() {
        return;
    }
    let other = if read_local_model() == LOCAL_MODEL_STANDARD {
        LOCAL_MODEL_HIGH
    } else {
        LOCAL_MODEL_STANDARD
    };
    if model_present_at(&local_model_dir().join(other)) {
        let _ = write_local_model(other);
    }
}

/// 참석자 이메일 → 표시 이름 매핑 캐시. 사용자가 인라인 편집으로 교정한 이름을 영구 보관.
/// 캘린더 attendee 이름 결정의 최우선 소스. `{ "email": "name" }` 단순 객체.
fn attendee_names_path() -> PathBuf {
    app_data_dir().join("attendee_names.json")
}

pub fn read_attendee_names() -> std::collections::HashMap<String, String> {
    fs::read_to_string(attendee_names_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_attendee_names(
    names: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(names)
        .map_err(|e| format!("attendee_names 직렬화 실패: {e}"))?;
    let path = attendee_names_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, json).map_err(|e| format!("attendee_names 쓰기 실패: {e}"))
}

/// LLM 작업을 수행하는 CLI 선택 — 사용자가 명시 선택한 값을 영구 보관(`active_cli` 텍스트 파일).
/// 값은 "claude"·"codex"·"antigravity"·"mlx"(로컬 LLM). 없으면 미선택(앱이 감지 결과로 선택
/// UI를 띄움). 목록은 프론트 `Cli` 유니온(types/index.ts)·isCli(constants.ts)·install.sh case와
/// 문자열 일치가 필요한 프로토콜 값.
fn active_cli_path() -> PathBuf {
    app_data_dir().join("active_cli")
}

fn is_known_cli(s: &str) -> bool {
    s == "claude" || s == "codex" || s == "mlx" || s == "antigravity"
}

pub fn read_active_cli() -> Option<String> {
    fs::read_to_string(active_cli_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| is_known_cli(s))
}

pub fn write_active_cli(cli: &str) -> Result<(), String> {
    if !is_known_cli(cli) {
        return Err(format!("알 수 없는 CLI: {cli}"));
    }
    let path = active_cli_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, cli).map_err(|e| format!("active_cli 쓰기 실패: {e}"))
}

/// 정밀 교정 토글의 sticky 기본값 — MeetingSelector가 마지막 선택을 기억해 다음 회의에 깔아둔다.
/// per-meeting 실제 값은 meeting.json의 detailed_correction에 기록되고, 이 파일은 UI 기본값일 뿐.
/// **"0"=OFF(빠름, 사용자가 끔), 그 외/부재=ON(정밀, 기본 opt-out).**
fn detailed_correction_default_path() -> PathBuf {
    app_data_dir().join("detailed_correction")
}

pub fn read_detailed_default() -> bool {
    // 기본값 = 정밀(true, opt-out). 사용자가 명시적으로 끈 경우("0")만 false. 부재(신규)·그 외는 정밀.
    fs::read_to_string(detailed_correction_default_path())
        .map(|s| s.trim() != "0")
        .unwrap_or(true)
}

pub fn write_detailed_default(on: bool) -> Result<(), String> {
    let path = detailed_correction_default_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, if on { "1" } else { "0" })
        .map_err(|e| format!("detailed_correction 기본값 쓰기 실패: {e}"))
}

/// 스킬 실행이 쓰는 Atlassian remote MCP 엔드포인트 — claude(.claude.json)·codex(config.toml)
/// 양쪽 전용 환경에 베이크되는 단일 값.
const ATLASSIAN_MCP_URL: &str = "https://mcp.atlassian.com/v1/mcp";

// antigravity(agy)는 Confluence 자동 발행을 **아직 지원하지 않는다(추후)**. agy CLI는 원격 MCP
// OAuth가 실제로 안 된다 — 네이티브 serverUrl은 `initialize: Unauthorized`로 실패(실측, agy
// Issue #25), mcp-remote는 Node 의존. 그래서 junmit은 antigravity에 atlassian을 등록하지 않고
// (전용 상수·ensure 함수 없음), 발행 모달이 antigravity의 자동 발행(create)을 막는다. 워크스페이스
// 신뢰 베이크(ensure_antigravity_trust)는 /meeting·/assist spawn에 필요하므로 유지.

/// codex 스킬 실행 전용 CODEX_HOME — 사용자 개인 `~/.codex`(플러그인·hooks·trust 가득)와
/// 격리된 junmit 소유 home. 격리 이유: skill 런타임이 사용자 설정에 안 흔들려 결정론적이고,
/// junmit 소유 config.toml에 Atlassian MCP를 박아 사용자 config를 0 터치(키체인 토큰은 user-global이라
/// 어느 home이든 공유). spawn(spawn.ts)·`codex login`·`codex login status`·`codex mcp login`이 모두
/// 이 경로를 CODEX_HOME으로 가리킨다.
pub fn codex_home() -> PathBuf {
    app_data_dir().join("codex")
}

/// Atlassian MCP "활성" 플래그 — Confluence/Jira를 실제로 쓰기 전(첫 발행 전)엔 MCP를 CLI
/// config에 선언하지 않는다. 그래야 Confluence를 안 쓰는 사용자가 codex/claude 기동마다
/// "atlassian MCP not logged in" 워닝을 보지 않는다. 첫 Confluence 발행 게이트가
/// `enable_atlassian_mcp`로 set하며, 한 번 켜지면 유지된다. codex·claude 공유(어느 CLI로
/// 켜도 양쪽 ensure가 동일 플래그를 본다) — CLI 전환 시에도 일관.
fn atlassian_flag_path() -> PathBuf {
    app_data_dir().join("atlassian_enabled")
}

pub fn atlassian_enabled() -> bool {
    atlassian_flag_path().exists()
}

/// 첫 Confluence 발행 게이트(claude/codex)에서 호출 — 플래그 set + 해당 CLI 격리 config에 MCP
/// 즉시 반영. 이후 그 CLI는 atlassian MCP를 선언한 채 뜬다.
/// 명시 match — `_` 폴백이면 새 CLI가 조용히 codex home에 베이크되는 무언 폴백 사고가 된다.
pub fn enable_atlassian_mcp(app: &tauri::AppHandle, cli: &str) -> Result<(), String> {
    let p = atlassian_flag_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("atlassian 플래그 디렉토리 생성 실패: {e}"))?;
    }
    if !p.exists() {
        fs::write(&p, b"1").map_err(|e| format!("atlassian 플래그 쓰기 실패: {e}"))?;
    }
    match cli {
        "claude" => ensure_claude_config_dir(app),
        // antigravity는 Confluence 발행 미지원(추후) — atlassian을 등록하지 않는다. 프론트가
        // antigravity의 자동 발행(create)을 게이팅하므로 이 경로는 실질적으로 안 탄다.
        "antigravity" => {}
        _ => ensure_codex_home(app),
    }
    Ok(())
}

/// agy 워크스페이스 신뢰 베이크 — 스킬 spawn cwd(appDir)를 사용자 전역
/// `~/.gemini/antigravity-cli/settings.json`의 `trustedWorkspaces`에 merge해 인터랙티브
/// 실행의 영문 신뢰 다이얼로그를 없앤다(claude `.claude.json`·codex config.toml 신뢰
/// 베이크와 패리티). 실측(A5): 다이얼로그는 존재하며 `--dangerously-skip-permissions`로
/// 우회되지 않고, 신뢰는 하위 디렉토리로 상속되지 않아 정확히 그 경로가 등록돼야 한다.
/// ⚠️ 사용자 소유 파일 — read-merge-write(기존 키·항목 전부 보존), 파싱 실패 시 불간섭
/// (다이얼로그가 한 번 뜨는 게 설정 파손보다 낫다), 원자 교체.
pub fn ensure_antigravity_trust(app: &tauri::AppHandle) {
    // 신뢰 대상 2곳: 스킬 spawn cwd(appDir) + 앱 데이터 디렉토리(app.junmit — spawn이
    // --add-dir로 워크스페이스에 포함하는 세션·신호·staging 위치. 추가 워크스페이스에도
    // 신뢰 프롬프트가 뜨지 않도록 함께 베이크).
    let mut wanted: Vec<String> = Vec::new();
    if let Ok(dir) = get_app_dir(app) {
        wanted.push(dir);
    }
    wanted.push(app_data_dir().to_string_lossy().into_owned());
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return;
    }
    let path = PathBuf::from(home).join(".gemini/antigravity-cli/settings.json");
    let mut root: serde_json::Value = match fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("antigravity settings.json 파싱 실패 — 불간섭: {e}");
                return;
            }
        },
        Err(_) => serde_json::json!({}),
    };
    let Some(obj) = root.as_object_mut() else {
        eprintln!("antigravity settings.json 루트가 객체가 아님 — 불간섭");
        return;
    };
    let list = obj
        .entry("trustedWorkspaces")
        .or_insert_with(|| serde_json::json!([]));
    let Some(arr) = list.as_array_mut() else {
        eprintln!("antigravity trustedWorkspaces가 배열이 아님 — 불간섭");
        return;
    };
    let mut changed = false;
    for dir in wanted {
        if !arr.iter().any(|v| v.as_str() == Some(dir.as_str())) {
            arr.push(serde_json::Value::String(dir));
            changed = true;
        }
    }
    if !changed {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&root) {
        Ok(s) => {
            let tmp = path.with_extension("json.junmit-tmp");
            if let Err(e) = fs::write(&tmp, s) {
                eprintln!("antigravity settings.json 임시 쓰기 실패: {e}");
                return;
            }
            if let Err(e) = fs::rename(&tmp, &path) {
                eprintln!("antigravity settings.json 교체 실패: {e}");
                let _ = fs::remove_file(&tmp);
            }
        }
        Err(e) => eprintln!("antigravity settings.json 직렬화 실패: {e}"),
    }
}

/// junmit 전용 CODEX_HOME을 idempotent하게 준비한다(디렉토리 + config.toml).
/// codex 사용 경로 전부에서 선행돼야 한다 — codex는 미존재 CODEX_HOME을 자동 생성하지 않고
/// "Error finding codex home"으로 하드 실패한다(공식: directory must already exist).
/// 호출 지점: 앱 기동(cmd_get_active_cli가 codex 반환 시)·CLI 선택 저장·detect.
///
/// ChatGPT 로그인은 seed하지 않는다 — 사용자가 junmit 환경에 1회 직접 로그인.
/// `~/.codex/auth.json` 복사·심링크는 refresh token이 single-use라(openai/codex#15410)
/// 어느 한쪽이 갱신하는 순간 다른 쪽이 깨지고, 최악엔 사용자 본인 세션을 무효화한다.
pub fn ensure_codex_home(app: &tauri::AppHandle) {
    let home = codex_home();
    if let Err(e) = fs::create_dir_all(&home) {
        eprintln!("codex home 생성 실패({}): {e}", home.display());
        return;
    }

    // PTY cwd(resources) trust 베이크 — 격리 home은 projects 기록이 없어 첫 인터랙티브 실행 시
    // 폴더-신뢰 프롬프트("Do you trust...")가 뜬다. 동봉 디렉토리(앱 자신의 Resources)라 신뢰가
    // 자명하므로 미리 박아 프롬프트를 없앤다(claude hasTrustDialogAccepted 베이크와 패리티).
    //
    // ★ union 보존 — dev·release 앱이 같은 CODEX_HOME을 공유하면 cwd가 달라(<ws>/resources vs
    // /Applications/Junmit.app/Contents/Resources) 단일 항목을 서로 덮어써 한쪽이 매번 신뢰
    // 프롬프트를 본다. 기존 [projects."..."] 경로를 모두 모아 현재 cwd와 합집합으로 다시 쓴다.
    let config_path = home.join("config.toml");
    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let cur_path = resource_dir(app)
        .map_err(|e| eprintln!("resource_dir 확인 실패(트러스트 베이크 생략): {e}"))
        .ok()
        .map(|p| p.display().to_string());
    let mut trusted: Vec<String> = existing
        .lines()
        .filter_map(|l| {
            l.trim()
                .strip_prefix("[projects.\"")
                .and_then(|s| s.strip_suffix("\"]"))
                .map(str::to_string)
        })
        .collect();
    if let Some(ref p) = cur_path {
        if !trusted.contains(p) {
            trusted.push(p.clone());
        }
    }
    let trust: String = trusted
        .iter()
        .map(|p| format!("\n[projects.\"{p}\"]\ntrust_level = \"trusted\"\n"))
        .collect();

    // junmit 소유 config.toml — 필요한 것만 명시, 나머지는 codex 기본값.
    // - cli_auth_credentials_store="file": ChatGPT 자격을 이 home의 auth.json에 격리.
    //   기본값(auto/keyring)은 OS 키체인 전역 항목이라 사용자 본인 codex 자격과 충돌 여지.
    // - agents.max_threads=6: meeting 1단계의 교정/라벨/매핑 3개 하위 에이전트 병렬 실행 여유.
    // - agents.max_depth=1: 루트가 직접 만든 하위 에이전트만 허용해 재귀 fan-out 방지.
    // - mcp_servers.atlassian: publish/assist가 쓰는 Confluence MCP. **lazy** — 첫 발행으로
    //   atlassian_enabled 플래그가 set됐을 때만 선언한다(미선언이면 비-Confluence 사용자가
    //   매 기동 보던 "not logged in" 워닝이 사라짐). 인증은 `codex mcp login atlassian`.
    //
    // 멱등 체크 — codex도 이 파일에 자체 상태를 기록하므로(모델 안내 표시 기록 등) 관리 항목이
    // 모두 현존하고 atlassian 선언 상태가 플래그와 일치하면 rewrite를 생략해 그 상태를 보존한다.
    // 관리 내용이 바뀐 경우(플래그 토글·MCP 엔드포인트 변경·앱 이동)에만 전체 rewrite.
    let want_atlassian = atlassian_enabled();
    let mut managed_keys = vec![
        "cli_auth_credentials_store = \"file\"".to_string(),
        "[agents]".to_string(),
        "max_threads = 6".to_string(),
        "max_depth = 1".to_string(),
    ];
    if want_atlassian {
        managed_keys.push("[mcp_servers.atlassian]".to_string());
        managed_keys.push(format!("url = \"{ATLASSIAN_MCP_URL}\""));
    }
    // 멱등 — 현재 cwd 신뢰가 이미 있고(또는 resource_dir 못 구함) 관리키·atlassian 선언이 일치하면
    // rewrite 생략(codex가 같은 파일에 쓰는 자체 상태 보존). 현재 cwd가 빠진 clobber 상황이면
    // 위 union으로 두 경로를 모두 담아 다시 쓴다.
    let trust_ok = cur_path
        .as_ref()
        .is_none_or(|p| existing.contains(&format!("[projects.\"{p}\"]")));
    let atlassian_ok = existing.contains("[mcp_servers.atlassian]") == want_atlassian;
    if !existing.is_empty()
        && trust_ok
        && atlassian_ok
        && managed_keys.iter().all(|k| existing.contains(k))
    {
        return;
    }

    let atlassian_block = if want_atlassian {
        format!("\n[mcp_servers.atlassian]\nurl = \"{ATLASSIAN_MCP_URL}\"\n")
    } else {
        String::new()
    };
    let config = format!(
        "\
# junmit 전용 Codex 설정 — 앱이 자동 생성·관리합니다. 사용자 ~/.codex와 분리된 격리 home.
# 직접 편집하지 마세요(앱이 덮어쓸 수 있음). Atlassian MCP는 첫 Confluence 발행 시 추가되며
# `codex mcp login atlassian`으로 인증합니다.

cli_auth_credentials_store = \"file\"

[agents]
max_threads = 6
max_depth = 1
{atlassian_block}{trust}"
    );
    if let Err(e) = fs::write(&config_path, config) {
        eprintln!("codex config.toml 쓰기 실패: {e}");
    }
}

/// claude 스킬 실행 전용 CLAUDE_CONFIG_DIR — 사용자 개인 `~/.claude`(전역 설정·세션 기록·
/// memories·플러그인)와 격리된 junmit 소유 환경. 격리 근거는 codex와 동일한 "제품 데이터 경계":
/// 회의 내용이 기록되는 곳(세션 로그)·hooks가 프롬프트를 수신하는 경로를 junmit이 소유한다.
/// 스킬(.claude/skills)·CLAUDE.md 자동 로드는 PTY cwd(resource_dir) 기반이라 영향 없음(실측:
/// 프로젝트 스킬 `./.claude/skills/`와 사용자 영역은 별도 경로). spawn(spawn.ts)·`claude auth
/// login/status`·`claude mcp list`가 모두 이 경로를 CLAUDE_CONFIG_DIR로 가리킨다.
pub fn claude_config_dir() -> PathBuf {
    app_data_dir().join("claude")
}

/// claude가 쓰는 "프로젝트 키" 규칙 재현 — git repo 안이면 git root, 아니면 canonical 경로(실측).
/// PTY cwd(resource_dir)의 폴더-신뢰를 .claude.json에 미리 박을 때 같은 키를 써야 적중한다.
/// dev에선 resources/가 워크스페이스 repo 안이라 git root, release 번들에선 Resources/ 자신.
fn claude_project_key(app: &tauri::AppHandle) -> Option<String> {
    let dir = resource_dir(app).ok()?;
    let dir = fs::canonicalize(&dir).unwrap_or(dir);
    let mut cur = dir.as_path();
    loop {
        if cur.join(".git").exists() {
            return Some(cur.to_string_lossy().into_owned());
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return Some(dir.to_string_lossy().into_owned()),
        }
    }
}

/// junmit 전용 CLAUDE_CONFIG_DIR을 idempotent하게 준비한다(디렉토리 + .claude.json 베이크).
/// claude는 미존재 dir·파일을 자동 생성하므로(codex와 다름) 생성 자체는 필수가 아니고,
/// 베이크가 목적이다:
/// - `mcpServers.atlassian`: publish/assist가 쓰는 Confluence MCP. `claude mcp add -s user`와
///   동일한 최상위(user scope) 기록(실측) — cwd 무관 적용. 인증은 발행 시점 `/mcp`로.
/// - `projects.<key>.hasTrustDialogAccepted`: PTY cwd 폴더-신뢰 선반영 — fresh 환경 첫
///   인터랙티브 실행의 영문 신뢰 다이얼로그를 없앤다(codex trust 베이크와 패리티).
///
/// ⚠️ codex config.toml과 달리 통파일 덮어쓰기 금지 — claude가 같은 파일에 로그인 메타
/// (oauthAccount)·온보딩 상태를 기록하므로 덮어쓰면 로그아웃 사고가 된다. 항상 read-merge-write,
/// 파싱 불가면 손대지 않는다(베이크 실패는 publish 스킬의 graceful 안내가 안전망).
///
/// 인증은 seed하지 않는다(못 한다) — 자격이 config dir에 귀속되어 .claude.json 복사로도
/// 로그인이 따라오지 않음(실측). 사용자가 junmit 환경에 `claude auth login` 1회.
pub fn ensure_claude_config_dir(app: &tauri::AppHandle) {
    let dir = claude_config_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("claude config dir 생성 실패({}): {e}", dir.display());
        return;
    }

    // ── sandbox + permissions 베이크 (settings.json = user settings) ──
    // claude는 sandbox.enabled를 user settings(CLAUDE_CONFIG_DIR/settings.json)에서 읽어
    // cwd·git-root·directory-trust와 무관하게 적용한다(permissions.md "Settings precedence" +
    // `autoAllowBashIfSandboxed`는 trust 무관하게 sandboxed bash를 자동 허용). 번들
    // projectSettings(resources/.claude/settings.json)는 cwd가 git-root로 인식되는 워크스페이스
    // 빌드/dev에서 로드되지 않아 sandbox가 죽으므로 여기로 일원화한다. .claude.json과 별개
    // 파일이고 claude가 theme 등 UI 상태를 같은 파일에 쓰므로 통파일 덮어쓰기 금지 —
    // read-merge-write로 관리 키만 병합. 아래 .claude.json 베이크의 early-return에 걸리지
    // 않도록 독립 블록으로 먼저 처리한다.
    {
        let settings_path = dir.join("settings.json");
        let mut settings: serde_json::Value = match fs::read_to_string(&settings_path) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("claude settings.json 파싱 실패(베이크 생략): {e}");
                    serde_json::Value::Null
                }
            },
            Err(_) => serde_json::json!({}),
        };
        if let Some(obj) = settings.as_object_mut() {
            let mut s_changed = false;

            // sandbox — 앱 소유 관리 블록. 값이 다르면 통째 교체(Value PartialEq는 키 순서 무관).
            // allowWrite에 PTY cwd(resource_dir)도 포함 — cwd가 빠지면 claude가 스킬 bash를 sandboxed로
            // 구성 못 해 unsandboxed로 떨어뜨려 매번 승인 프롬프트가 뜬다(샌드박스 쓰기 범위 = cwd + allowWrite).
            //
            // ★ 반드시 **절대경로**로 넣는다(틸드 `~` 금지). 세션 산출물은 app_data_dir/output/...에
            // 쓰는데(예: /meeting의 transcript_corrected.txt 생성·apply-edits), allowWrite의 `~`가
            // 샌드박스에서 제대로 확장되지 않으면(공백 포함 "Application Support" 경로 엣지케이스, 실측)
            // 그 쓰기가 범위 밖이 돼 unsandboxed로 떨어지고 "정적 분석 불가" 승인 프롬프트가 뜬다.
            // 절대경로면 하위 트리(output/세션)까지 재귀 허용된다(공식 sandbox 문서). resource_dir도 절대경로.
            let mut allow_write: Vec<String> =
                vec![app_data_dir().to_string_lossy().into_owned()];
            if let Ok(res) = resource_dir(app) {
                allow_write.push(res.to_string_lossy().into_owned());
            }
            let want_sandbox = serde_json::json!({
                "enabled": true,
                "autoAllowBashIfSandboxed": true,
                "filesystem": { "allowWrite": allow_write }
            });
            if obj.get("sandbox") != Some(&want_sandbox) {
                obj.insert("sandbox".to_string(), want_sandbox);
                s_changed = true;
            }

            // auto mode 진입 고지(opt-in 다이얼로그) 억제 — 이 고지가 세션 시작 시 떠서 자동 /meeting
            // 파이프라인을 멈추면 안 된다. claude는 userSettings의 skipAutoPermissionPrompt=true를
            // "opt-in 다이얼로그 수락됨"으로 보고 고지를 건너뛴다(2.1.x 바이너리 실측: 게이트가
            // `skipAutoPermissionPrompt===true || hasSeenAutoModeEntryWarning`이면 early-return).
            // 위 defaultMode:"auto"와 **함께** 둬야 한다 — claude migration이 둘 중 하나만 있으면
            // skipAutoPermissionPrompt를 리셋한다.
            if obj.get("skipAutoPermissionPrompt").and_then(|v| v.as_bool()) != Some(true) {
                obj.insert("skipAutoPermissionPrompt".to_string(), serde_json::json!(true));
                s_changed = true;
            }

            // permissions.allow — 관리 항목 union(사용자/claude가 /permissions로 추가한 항목 보존).
            let want_allow = [
                "Read(~/Library/Application Support/app.junmit/**)",
                "Edit(~/Library/Application Support/app.junmit/**)",
                "Write(~/Library/Application Support/app.junmit/**)",
                "mcp__atlassian__*",
                "mcp__claude_ai_Atlassian__*",
            ];
            if let Some(perms) = obj
                .entry("permissions")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
            {
                // auto mode — 변수확장 든 bash처럼 정적 분석 불가라 sandbox 자동허용이 못 잡는
                // 명령을 분류기 모델이 의도 기준으로 판단해 프롬프트 없이 실행한다(위험 행동은 여전히
                // 차단). 스킬 bash마다 wrapper로 확장을 숨기는 대신 모드로 일괄 해결. `defaultMode:"auto"`
                // 는 **user settings에서만** 인정되는데 이 config dir(CLAUDE_CONFIG_DIR)이 user settings
                // 자리라 적용된다. sandbox 설정은 그대로 둬 실행 격리(defense-in-depth)는 유지. claude 2.1.83+.
                if perms.get("defaultMode").and_then(|v| v.as_str()) != Some("auto") {
                    perms.insert("defaultMode".to_string(), serde_json::json!("auto"));
                    s_changed = true;
                }
                if let Some(arr) = perms
                    .entry("allow")
                    .or_insert_with(|| serde_json::json!([]))
                    .as_array_mut()
                {
                    for want in want_allow {
                        let v = serde_json::json!(want);
                        if !arr.contains(&v) {
                            arr.push(v);
                            s_changed = true;
                        }
                    }
                }
            }

            if s_changed {
                match serde_json::to_string_pretty(&settings) {
                    Ok(j) => {
                        if let Err(e) = fs::write(&settings_path, j) {
                            eprintln!("claude settings.json 쓰기 실패: {e}");
                        } else {
                            // .claude.json과 동일하게 0600 — 일관성.
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                let _ = fs::set_permissions(
                                    &settings_path,
                                    fs::Permissions::from_mode(0o600),
                                );
                            }
                        }
                    }
                    Err(e) => eprintln!("claude settings.json 직렬화 실패: {e}"),
                }
            }
        } else {
            eprintln!("claude settings.json 루트가 객체가 아님(베이크 생략)");
        }
    }

    let config_path = dir.join(".claude.json");
    let mut config: serde_json::Value = match fs::read_to_string(&config_path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("claude .claude.json 파싱 실패(베이크 생략): {e}");
                return;
            }
        },
        Err(_) => serde_json::json!({}),
    };
    let Some(root) = config.as_object_mut() else {
        eprintln!("claude .claude.json 루트가 객체가 아님(베이크 생략)");
        return;
    };

    let mut changed = false;

    // 온보딩 위저드 마커 — `claude auth login`은 로그인만 기록하고 이 마커를 안 쓰므로(실측)
    // 첫 인터랙티브 실행이 테마·로그인 온보딩 위저드를 띄워 회의 흐름을 가로막는다(이미 로그인돼
    // 있어도 위저드는 로그인 단계를 또 보여줌). 완료로 베이크해 위저드 자체를 건너뛴다(테마는
    // claude 기본값 사용).
    if root.get("hasCompletedOnboarding").and_then(|v| v.as_bool()) != Some(true) {
        root.insert("hasCompletedOnboarding".to_string(), serde_json::json!(true));
        changed = true;
    }

    // "Claude in Chrome extension detected · use my browser?" 프롬프트 차단. Chrome/Edge 확장이
    // 설치된 머신에선 세션 시작 시 이 프롬프트가 매번 뜬다("No"를 골라도 onboarding 마커를 안 남겨
    // 반복). claude 2.1.x 바이너리 실측: 표시 게이트가 `!hasCompletedClaudeInChromeOnboarding`라,
    // 이를 true로 베이크하면 프롬프트 자체가 안 뜬다. 앱 세션은 브라우저 도구를 쓰지 않으므로
    // claudeInChromeDefaultEnabled=false로 도구는 off 유지. 둘 다 전역 키. 사용자의 일반 Claude
    // Code(다른 CONFIG_DIR)에는 영향 없음.
    if root
        .get("hasCompletedClaudeInChromeOnboarding")
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        root.insert(
            "hasCompletedClaudeInChromeOnboarding".to_string(),
            serde_json::json!(true),
        );
        changed = true;
    }
    if root
        .get("claudeInChromeDefaultEnabled")
        .and_then(|v| v.as_bool())
        != Some(false)
    {
        root.insert(
            "claudeInChromeDefaultEnabled".to_string(),
            serde_json::json!(false),
        );
        changed = true;
    }

    // atlassian MCP는 **lazy** — 첫 Confluence 발행으로 플래그가 set됐을 때만 선언한다.
    // 미설정이면 선언하지 않고(비-Confluence 사용자 워닝 제거), 과거에 박힌 게 있으면 제거한다.
    if atlassian_enabled() {
        let atlassian = serde_json::json!({ "type": "http", "url": ATLASSIAN_MCP_URL });
        if let Some(servers) = root
            .entry("mcpServers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
        {
            if servers.get("atlassian") != Some(&atlassian) {
                servers.insert("atlassian".to_string(), atlassian);
                changed = true;
            }
        }
    } else if let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        if servers.remove("atlassian").is_some() {
            changed = true;
        }
    }

    if let Some(key) = claude_project_key(app) {
        if let Some(projects) = root
            .entry("projects")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
        {
            if let Some(project) = projects
                .entry(key)
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
            {
                if project.get("hasTrustDialogAccepted").and_then(|v| v.as_bool()) != Some(true) {
                    project.insert("hasTrustDialogAccepted".to_string(), serde_json::json!(true));
                    changed = true;
                }
            }
        }
    }

    if !changed {
        return;
    }
    let json = match serde_json::to_string_pretty(&config) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("claude .claude.json 직렬화 실패: {e}");
            return;
        }
    };
    if let Err(e) = fs::write(&config_path, json) {
        eprintln!("claude .claude.json 쓰기 실패: {e}");
        return;
    }
    // claude 자신이 만드는 파일과 동일하게 0600 — 로그인 후 계정 메타가 기록되는 파일.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&config_path, fs::Permissions::from_mode(0o600));
    }
}

/// 설치/인증 감지 결과 — 온보딩 "AI 도구 선택" 화면이 카드 상태 표시에 사용.
/// claude는 `claude auth status`(exit 0=로그인, 2.1.x), codex는 `codex login status`(exit 0=로그인)로
/// 각자의 junmit 전용 환경 기준 인증까지 결정론적 확인. `auth` 서브커맨드가 없는 구버전 claude는
/// exit≠0 → 미인증으로 보여 로그인 단계로 안내되는데, 그 로그인 도우미가 최신 설치를 유도한다.
/// antigravity는 격리 환경이 없어 사용자 전역 로그인 기준(`agy models` 출력 판별).
/// 평면 필드는 프론트 CliAvailability(types/index.ts)와 serde 계약 — 에이전트 CLI가 하나 더
/// 늘면 맵 구조 리팩터를 별도 작업으로.
#[derive(Serialize)]
pub struct CliAvailability {
    pub claude: bool,
    pub claude_authed: bool,
    pub codex: bool,
    pub codex_authed: bool,
    pub antigravity: bool,
    pub antigravity_authed: bool,
}

fn cli_installed(bin: &str) -> bool {
    Command::new("/usr/bin/which")
        .arg(bin)
        .env("PATH", get_user_shell_path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// antigravity CLI 실행 경로 — `which agy`를 쓰지 않고 절대경로 고정.
/// Antigravity IDE도 동명 `agy` 런처를 설치하는데(~/.antigravity/antigravity/bin/agy, VS Code
/// `code` 대응물) 그쪽은 어떤 인자든 help를 찍고 exit 0이라 which·종료코드 기반 판별이 전부
/// 오탐된다. CLI 공식 인스톨러는 ~/.local/bin/agy에 고정 설치하고 자가 업데이트도 in-place라
/// 이 경로가 안정적(spawn의 PATH 앞줄 $HOME/.local/bin과 같은 해석).
fn antigravity_cli_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join(".local/bin/agy");
    p.is_file().then_some(p)
}

/// agy엔 로그인 상태 서브커맨드가 없다(실측 1.0.16 — auth/mcp 서브커맨드 부재).
/// `agy models`로 판별한다: 미인증이면 "Error: Please sign in …"(exit 0! — 종료 코드 무의미,
/// 실측), 인증이면 모델 목록. 그래서 출력 텍스트로 가른다 — "sign in" 마커 **또는 "error"
/// 계열 출력**이 보이면 미인증. 문구가 개편돼도 오류 출력엔 "error"가 남을 가능성이 높아,
/// 미인증을 로그인됨으로 오판하는 방향(온보딩 통과 후 스킬 실행이 로그인 화면에 걸리는
/// 최악)을 좁힌다. 반대 방향 오판(인증인데 미인증 표시)은 로그인 화면 안내 + "다시 확인"으로
/// 복구 가능해 덜 위험하다. 잔여 위험: 오류 표기가 완전히 사라지는 개편 — E2E 체크리스트에서
/// 릴리즈마다 확인.
/// 인증 시엔 서버 왕복이라(오프라인·서버 지연에 노출) 10초 타임아웃을 두고, 초과·실행 실패는
/// 미인증 취급. std Command엔 output 타임아웃이 없어 try_wait 폴링으로 구현 — 모델 목록은
/// 파이프 버퍼(64KB)보다 훨씬 작아 파이프 막힘 걱정은 없다.
fn antigravity_logged_in() -> bool {
    use std::time::{Duration, Instant};
    let Some(agy) = antigravity_cli_path() else {
        return false;
    };
    let mut child = match Command::new(agy)
        .arg("models")
        .env("PATH", get_user_shell_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = child.kill();
                return false;
            }
        }
    }
    let Ok(output) = child.wait_with_output() else {
        return false;
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_lowercase();
    output.status.success() && !text.contains("sign in") && !text.contains("error")
}

fn codex_logged_in() -> bool {
    Command::new("codex")
        .args(["login", "status"])
        .env("PATH", get_user_shell_path())
        .env("CODEX_HOME", codex_home())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn claude_logged_in() -> bool {
    Command::new("claude")
        .args(["auth", "status"])
        .env("PATH", get_user_shell_path())
        .env("CLAUDE_CONFIG_DIR", claude_config_dir())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 선택 CLI의 Atlassian MCP 인증 여부 — 발행(create 모드) 직전 JIT 게이트가 호출한다.
/// 둘 다 junmit 전용 환경 기준이며, 미인증이 확실할 때만 false — 그 외(항목 부재·필드 부재·
/// 포맷 변화)는 통과시키고 실제 MCP 호출 실패는 publish 스킬이 안내하게 둔다 (게이트는 best-effort).
/// - codex: `codex mcp list --json`의 `auth_status` == "not_logged_in"만 미인증.
/// - claude: `claude mcp list` 텍스트(--json 부재, 실측)의 atlassian 라인에
///   "Needs authentication" 표시만 미인증("✔ Connected"는 통과).
pub fn cli_atlassian_authed(app: &tauri::AppHandle, cli: &str) -> Result<bool, String> {
    if cli == "claude" {
        return claude_atlassian_authed(app);
    }
    if cli == "antigravity" {
        // antigravity는 Confluence 자동 발행 미지원(추후) — atlassian을 관리하지 않는다.
        // 프론트가 antigravity의 create(자동 발행)를 애초에 막으므로 이 경로는 안 탄다.
        return Ok(false);
    }
    // config.toml에 atlassian 서버가 베이크돼 있어야 목록에 잡힌다.
    ensure_codex_home(app);
    let output = Command::new("codex")
        .args(["mcp", "list", "--json"])
        .env("PATH", get_user_shell_path())
        .env("CODEX_HOME", codex_home())
        .output()
        .map_err(|e| format!("codex 실행 실패: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "codex mcp list 실패: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let servers: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("codex mcp list 출력 파싱 실패: {e}"))?;
    // atlassian 항목이 아예 없으면(config 유실 등) true — 로그인으로 해결될 문제가 아니라
    // 게이트를 반복해봐야 사용자만 막힌다. 스킬 단계에서 실패가 드러나는 쪽을 택한다.
    let authed = servers
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s.get("name").and_then(|v| v.as_str()) == Some("atlassian"))
        .all(|s| s.get("auth_status").and_then(|v| v.as_str()) != Some("not_logged_in"));
    Ok(authed)
}

fn claude_atlassian_authed(app: &tauri::AppHandle) -> Result<bool, String> {
    // .claude.json에 atlassian 서버가 베이크돼 있어야 목록에 잡힌다.
    ensure_claude_config_dir(app);
    let output = Command::new("claude")
        .args(["mcp", "list"])
        .env("PATH", get_user_shell_path())
        .env("CLAUDE_CONFIG_DIR", claude_config_dir())
        .output()
        .map_err(|e| format!("claude 실행 실패: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "claude mcp list 실패: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // "atlassian: <url> (HTTP) - ! Needs authentication" 형태(실측). 미인증 표시가 있는
    // atlassian 라인만 false — 라인 부재·표현 변화는 codex와 같은 이유로 통과.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let authed = stdout
        .lines()
        .filter(|l| l.trim_start().starts_with("atlassian:"))
        .all(|l| !l.contains("Needs authentication"));
    Ok(authed)
}

pub fn detect_clis(app: &tauri::AppHandle) -> CliAvailability {
    let claude = cli_installed("claude");
    let codex = cli_installed("codex");
    // antigravity는 which가 아닌 절대경로 존재 확인 — IDE 런처 동명 오탐 방지(함수 doc 참고).
    let antigravity = antigravity_cli_path().is_some();
    // 전용 환경을 먼저 준비(설치돼 있을 때만) — 인증 판정이 junmit 환경 기준으로 결정.
    // antigravity는 여기서 ensure를 **하지 않는다**: claude/codex ensure는 junmit 소유
    // 격리 디렉토리라 무해하지만, antigravity 신뢰 베이크는 사용자 전역 settings.json
    // 수정이다 — 감지는 카드를 그리기만 해도 돌므로, antigravity를 선택하지 않은(고지도
    // 못 본) 사용자의 파일을 만지게 된다. 베이크는 선택/기동 시점(cmd_get/set_active_cli —
    // 선택 화면의 고지 문구와 같은 동의 맥락)만으로 충분하다. spawn은 항상 그 뒤다.
    if claude {
        ensure_claude_config_dir(app);
    }
    if codex {
        ensure_codex_home(app);
    }
    // 인증 판정 3건은 독립 프로세스라 병렬 — agy는 네트워크 왕복(최대 10초 타임아웃)이라
    // 직렬이면 그 지연이 감지 총 시간에 그대로 합산된다(온보딩 카드·도우미 종료 후 재감지).
    let (claude_authed, codex_authed, antigravity_authed) = std::thread::scope(|s| {
        let c = s.spawn(|| claude && claude_logged_in());
        let x = s.spawn(|| codex && codex_logged_in());
        let a = s.spawn(|| antigravity && antigravity_logged_in());
        (
            c.join().unwrap_or(false),
            x.join().unwrap_or(false),
            a.join().unwrap_or(false),
        )
    });
    CliAvailability {
        claude,
        claude_authed,
        codex,
        codex_authed,
        antigravity,
        antigravity_authed,
    }
}

/// 전사 품질 향상용 용어 사전. whisper `--prompt` priming + 후보정 LLM 교정에 쓰임.
/// 사용자가 앱에서 직접 편집하는 단일 진실 원천. 첫 실행 시 시드(번들 동봉)에서 복사된다.
/// `{ "terms": [...] }` 객체 래퍼 — 추후 오인식 힌트 등 형제 필드를 무중단 확장하기 위함.
fn vocabulary_path() -> PathBuf {
    app_data_dir().join("vocabulary.json")
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Vocabulary {
    #[serde(default)]
    pub terms: Vec<String>,
}

pub fn read_vocabulary() -> Vocabulary {
    fs::read_to_string(vocabulary_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_vocabulary(vocab: &Vocabulary) -> Result<(), String> {
    let json = serde_json::to_string_pretty(vocab)
        .map_err(|e| format!("vocabulary 직렬화 실패: {e}"))?;
    let path = vocabulary_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, json).map_err(|e| format!("vocabulary 쓰기 실패: {e}"))
}

/// 표준 macOS 앱 로그 위치 — `~/Library/Logs/app.junmit/`.
/// Console.app에서 자동 인식되어 진단 편함.
pub fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Logs").join(BUNDLE_IDENTIFIER)
}

/// 앱 리소스(`.claude/`, `lib/*.sh`, `bin/*`, `vocabulary.json`, `install.sh`, `templates/`) 디렉토리.
/// - dev (debug build): 워크스페이스의 `resources/` (`CARGO_MANIFEST_DIR/../resources/`)
/// - release: 앱 번들의 `Contents/Resources/`
///   tauri.conf.json의 `bundle.resources`로 빌드 시 자동 복사됨.
///
/// PTY cwd로도 이 값이 쓰임 — IDE Claude Code(워크스페이스 root에서 실행)와 분리되어
/// 개발 중 `.claude/skills/`가 IDE에 user-invocable로 자동 노출되지 않도록 한 의도적 배치.
pub fn resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest.parent()
            .map(|p| p.join("resources"))
            .ok_or_else(|| "워크스페이스 루트를 찾을 수 없습니다".into())
    }
    #[cfg(not(debug_assertions))]
    {
        app.path().resource_dir().map_err(|e| format!("resource_dir 실패: {e}"))
    }
}

/// 시작 시 자기 앱 번들의 com.apple.quarantine xattr 제거 (best-effort).
/// 미서명 앱이 자가업데이트로 .app을 교체한 뒤 재실행될 때 Gatekeeper
/// "확인되지 않은 개발자" 경고 재발을 막는 안전벨트다. 미서명 앱도 자기 소유
/// 번들의 quarantine은 권한이 충분해 제거할 수 있다. Tauri updater는 브라우저가
/// 아닌 자체 HTTP로 받아 보통 quarantine이 안 붙지만, 만약 붙어도 여기서 정리된다.
/// release 빌드에서만 의미 있다(dev는 .app 번들이 아니라 no-op).
pub fn strip_own_quarantine() {
    #[cfg(not(debug_assertions))]
    {
        // 현재 실행 파일: …/Junmit.app/Contents/MacOS/<bin> → 3단계 상위가 .app 번들
        let Some(bundle) = std::env::current_exe()
            .ok()
            .and_then(|p| p.ancestors().nth(3).map(PathBuf::from))
        else {
            return;
        };
        if !bundle.extension().map(|e| e == "app").unwrap_or(false) {
            return;
        }
        // quarantine이 실제로 붙어 있을 때만 제거 — 정상 경우(미부착)엔 완전 no-op.
        // Tauri updater는 자체 HTTP로 받아 보통 quarantine을 안 붙이고, 첫 실행
        // Gatekeeper 승인 이후에만 이 경로에 도달한다. 보안도구(EDR)가 "미서명
        // 프로세스의 quarantine 제거"를 침해지표로 보므로 불필요한 호출을 피한다.
        let present = Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&bundle)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if present {
            let _ = Command::new("/usr/bin/xattr")
                .args(["-dr", "com.apple.quarantine"])
                .arg(&bundle)
                .status();
        }
    }
}


/// 캘린더 참석자 — 이메일(안정 식별자) + EKParticipant.name 원시값.
/// 표시 이름 결정(캐시·휴리스틱·fallback)은 프론트엔드가 담당.
#[derive(Serialize, Deserialize, Clone)]
pub struct Attendee {
    pub email: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct CalendarEvent {
    pub title: String,
    pub time: String,
    pub attendees: Vec<Attendee>,
    /// 회의 예상 시간(분). time이 "HH:MM-HH:MM" 형식이면 계산, 아니면 None.
    pub duration_min: Option<u32>,
    /// 캘린더 description을 Markdown으로 변환한 본문 (Swift측에서 변환). 비어있을 수 있음.
    pub notes: String,
}

/// "HH:MM-HH:MM" 포맷에서 분 단위 duration 계산. 자정 넘기면 24h 보정.
fn parse_duration_min(time: &str) -> Option<u32> {
    let (start, end) = time.split_once('-')?;
    let to_min = |s: &str| -> Option<i32> {
        let (h, m) = s.trim().split_once(':')?;
        Some(h.parse::<i32>().ok()? * 60 + m.parse::<i32>().ok()?)
    };
    let s = to_min(start)?;
    let e = to_min(end)?;
    let diff = if e >= s { e - s } else { e + 24 * 60 - s };
    if diff > 0 && diff <= 24 * 60 { Some(diff as u32) } else { None }
}

#[derive(Deserialize)]
struct CalendarFetchResult {
    ok: bool,
    events: Option<Vec<CalendarEventDTO>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct CalendarEventDTO {
    title: String,
    time: String,
    attendees: Vec<Attendee>,
    #[serde(default)]
    notes: String,
}

/// 오늘 캘린더 일정 조회. 메인 앱 프로세스에서 EventKit을 호출해야 TCC가 bundle identity로 권한 귀속.
pub fn fetch_calendar_events(_app: &tauri::AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let date_cstr = CString::new("").map_err(|e| format!("CString 생성 실패: {e}"))?;
    let json_str = unsafe {
        take_ffi_string(native_fetch_calendar_events(date_cstr.as_ptr()))
            .ok_or_else(|| "native_fetch_calendar_events returned null".to_string())?
    };

    let parsed: CalendarFetchResult = serde_json::from_str(&json_str)
        .map_err(|e| format!("calendar JSON parse 실패: {e}"))?;

    if !parsed.ok {
        let err = parsed.error.unwrap_or_default();
        if err == "no_permission" {
            // 프론트가 권한 거부를 식별하도록 sentinel prefix 부여
            return Err("[NO_CALENDAR_PERMISSION] 캘린더 권한이 없습니다. 시스템 설정에서 허용해주세요.".into());
        }
        return Err(format!("캘린더 조회 실패: {err}"));
    }

    let events = parsed
        .events
        .unwrap_or_default()
        .into_iter()
        .map(|e| {
            let duration_min = parse_duration_min(&e.time);
            CalendarEvent {
                title: e.title,
                time: e.time,
                attendees: e.attendees,
                duration_min,
                notes: e.notes,
            }
        })
        .collect();

    Ok(events)
}

/// "not_determined" | "restricted" | "denied" | "authorized"
pub fn mic_permission_status() -> &'static str {
    match unsafe { native_mic_permission_status() } {
        0 => "not_determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "not_determined",
    }
}

/// 마이크 권한 OS 다이얼로그를 띄우고 응답까지 대기 후 갱신된 상태 반환. 네이티브 마이크 전환 전엔
/// 브라우저 getUserMedia가 이 역할을 했다(MeetingSelector가 not_determined일 때 호출).
pub fn request_mic_permission() -> &'static str {
    match unsafe { native_request_mic_permission() } {
        0 => "not_determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "not_determined",
    }
}

/// "not_determined" | "restricted" | "denied" | "authorized"
pub fn calendar_permission_status() -> &'static str {
    match unsafe { native_calendar_permission_status() } {
        0 => "not_determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "not_determined",
    }
}

// ── 시스템 오디오 캡처 (CoreAudio Process Tap) ────────────────────────────
// 마이크는 브라우저가 잡고, 시스템 출력 오디오만 네이티브로 캡처해 종료 시 ffmpeg로 오프라인 믹스한다.
// 녹음 중에는 세션 디렉토리가 아직 없으므로 app_data_dir의 스테이징 파일에 기록하고, convert에서 이동·믹스한다.

/// capture_mode 값 — meeting.json에 기록. "mic"=마이크만, "mic+system"=시스템 오디오 포함.
pub const CAPTURE_MODE_MIC: &str = "mic";
pub const CAPTURE_MODE_MIC_SYSTEM: &str = "mic+system";

/// 녹음 중 시스템 오디오를 기록하는 스테이징 파일(48k 스테레오 16-bit WAV). 단독 사용자·단일 녹음이라 고정 경로.
fn system_audio_staging_path() -> PathBuf {
    app_data_dir().join("recording_system_staging.wav")
}

/// 녹음 중 마이크를 기록하는 스테이징 파일(48k mono 16-bit WAV). 네이티브 마이크 캡처가 녹음 중 직접
/// 기록하고, convert_recording이 이 파일을 입력으로 삼아 16k 변환·정규화·믹스한다. 세션 디렉토리는
/// 녹음 종료 후에야 만들어지므로 시스템 오디오와 동일하게 app_data_dir에 고정 경로로 둔다.
fn mic_staging_path() -> PathBuf {
    app_data_dir().join("recording_mic_staging.wav")
}

/// 녹음 오디오 보존 게이트(숨은 개발자 플래그). `app_data_dir/keep_recording` 센티넬 파일이
/// 있으면 모든 오디오 산출물을 보존한다: ① 화자분리 후 recording.wav를 지우지 않고(기본=삭제),
/// ② convert_recording이 믹스 후 마이크·시스템 원본 트랙(스템)도 남긴다. 회의 원본 오디오는
/// 민감하므로 release는 전사·화자분리가 끝나면 자동 삭제하는 게 기본(Granola식); 이 플래그는
/// 재처리·믹스 진단·AEC 실험을 위해 개발자가 직접 켜는 escape다(UI 없음, dev/release 동일).
fn should_keep_recording() -> bool {
    app_data_dir().join("keep_recording").exists()
}

/// 화자분리(오디오를 쓰는 마지막 단계) 완료 후 호출 — 회의 원본 오디오를 정리한다.
/// recording.wav는 전사·화자분리 입력이지만 이후 `/meeting`(텍스트만 사용)·발행엔 불필요하다.
/// 민감한 원본을 기본 삭제(프라이버시)하되, keep_recording 센티넬이 있으면 보존(재처리·진단).
/// 삭제 실패는 비치명(로그만) — 정리 누락이 파이프라인을 막지 않는다.
pub fn cleanup_recording_audio(session_dir: &str) {
    if should_keep_recording() {
        return;
    }
    let wav = PathBuf::from(session_dir).join("recording.wav");
    if wav.exists() {
        if let Err(e) = fs::remove_file(&wav) {
            eprintln!("recording.wav 정리 실패(무시): {e}");
        }
    }
}

/// 16k mono s16le headerless raw 파일을 **청크 스트리밍**으로 읽어 윈도우별 RMS 엔벨로프만 만든다.
/// 전체 샘플을 메모리에 적재하지 않으므로(엔벨로프는 수십 KB 수준) 긴 회의에서도 메모리가 작다.
/// 마지막 부분 윈도우(win 미만)도 실제 길이로 RMS를 내 포함한다(`chunks(win)` 동작과 동일).
fn windowed_rms_file(path: &std::path::Path, win: usize) -> Vec<f64> {
    use std::io::Read;
    let Ok(mut f) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut env = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut sumsq = 0.0f64;
    let mut count = 0usize;
    let mut carry: Option<u8> = None; // 청크 경계에 걸친 홀수 바이트
    loop {
        let n = match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let mut i = 0;
        // 직전 청크에서 남은 1바이트 + 이번 청크 첫 바이트로 한 샘플 완성
        if let Some(lo) = carry.take() {
            let s = i16::from_le_bytes([lo, buf[0]]) as f64;
            sumsq += s * s;
            count += 1;
            if count == win {
                env.push((sumsq / win as f64).sqrt());
                sumsq = 0.0;
                count = 0;
            }
            i = 1;
        }
        while i + 1 < n {
            let s = i16::from_le_bytes([buf[i], buf[i + 1]]) as f64;
            sumsq += s * s;
            count += 1;
            if count == win {
                env.push((sumsq / win as f64).sqrt());
                sumsq = 0.0;
                count = 0;
            }
            i += 2;
        }
        if i < n {
            carry = Some(buf[i]); // 홀수 바이트 1개 다음 청크로 이월
        }
    }
    if count > 0 {
        env.push((sumsq / count as f64).sqrt());
    }
    env
}

/// Pearson 상관계수. 표본 < 2거나 분산 0이면 None.
fn pearson(a: &[f64], b: &[f64]) -> Option<f64> {
    let n = a.len().min(b.len());
    if n < 2 {
        return None;
    }
    let ma = a[..n].iter().sum::<f64>() / n as f64;
    let mb = b[..n].iter().sum::<f64>() / n as f64;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let x = a[i] - ma;
        let y = b[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    let den = (da * db).sqrt();
    (den != 0.0).then_some(num / den)
}

// 에코 판정 공통 상수.
// 윈도우 500ms: 마이크 에코는 캡처 시작 오프셋으로 tap보다 ~165ms 늦는데(실측), 윈도우가 그보다 작으면
// 두 엔벨로프가 어긋나 상관이 깎인다(100ms에선 0.30로 오판). 500ms면 지연을 흡수해 스피커 0.85 / 헤드폰 ~0로
// 깨끗이 갈린다(실측).
const ECHO_WIN: usize = 8000; // 500ms @16k
const ECHO_ACTIVE_THRESH: f64 = 328.0; // tap-active(원격 발화) 판정 ~ -40 dBFS (0.01 * 32768)
const ECHO_MIN_ACTIVE: usize = 8; // 시스템에 최소 ~4초 분량의 실제 발화가 있어야 "원격 있음"으로 본다
const ECHO_CORR_THRESH: f64 = 0.5; // 스피커 실측 0.85 / 헤드폰 ~0 → 0.5로 명확히 분리

/// 시스템(tap) 캡처에 실제 원격 발화가 있는가 — tap-active 윈도우가 충분한지. false면 대면/무음(tap이 무음을
/// 캡처)이라 원격이 없는 것 → 에코·믹스 로직을 타지 않고 마이크-only로 간다(capture_mode=mic).
fn system_has_speech(sys_raw: &std::path::Path) -> bool {
    let sr = windowed_rms_file(sys_raw, ECHO_WIN);
    sr.iter().filter(|&&v| v > ECHO_ACTIVE_THRESH).count() >= ECHO_MIN_ACTIVE
}

/// 마이크가 시스템(tap)을 음향 에코로 담고 있는가 — "원격 발화 중(tap-active) 구간에서 마이크 RMS가
/// tap RMS를 따라가는가"를 상관계수로 본다. 스피커 사용 시 원격이 스피커→마이크로 재유입되면 두 엔벨로프가
/// 강하게 상관(실측 ~0.85). 헤드폰이면 원격 발화 중 마이크는 (듣는 중이라) 조용/무상관(실측 ~0).
/// (호출 전 system_has_speech가 true임을 전제 — 충분한 tap-active 윈도우 존재.)
///
/// 높으면(스피커) → 마이크가 이미 원격을 담고 있어 tap을 섞으면 더블링/울림(comb-filter, 실측 전사 파괴).
/// → mic-only가 안전하고 깨끗(더블링 원천 회피). 낮으면(헤드폰) → tap이 유일한 원격 소스라 믹스 필요.
/// device-agnostic(내장/외부/회의실 스피커 구분 불필요) — OS 출력 기기 감지의 불확실성을 우회한다.
fn mic_echoes_system(mic_raw: &std::path::Path, sys_raw: &std::path::Path) -> bool {
    let mr = windowed_rms_file(mic_raw, ECHO_WIN);
    let sr = windowed_rms_file(sys_raw, ECHO_WIN);
    // 두 파일 길이가 달라도 윈도우 0..k-1은 같은 샘플 구간(둘 다 0부터 win 단위)이라 정렬됨.
    let k = mr.len().min(sr.len());
    let active: Vec<usize> = (0..k).filter(|&i| sr[i] > ECHO_ACTIVE_THRESH).collect();
    if active.len() < ECHO_MIN_ACTIVE {
        return false;
    }
    let mv: Vec<f64> = active.iter().map(|&i| mr[i]).collect();
    let sv: Vec<f64> = active.iter().map(|&i| sr[i]).collect();
    pearson(&mv, &sv).map(|c| c >= ECHO_CORR_THRESH).unwrap_or(false)
}

/// TCC 권한 상태를 마이크/캘린더와 같은 4-state 문자열로 정규화 (TCC엔 restricted 없음).
pub fn system_audio_permission_status() -> &'static str {
    match unsafe { native_system_audio_permission_status() } {
        0 => "authorized",
        1 => "denied",
        _ => "not_determined",
    }
}

/// 권한 프롬프트를 띄우고 응답까지 대기 후 갱신된 상태 반환. 토글 ON·권한 카드의 "요청"이 호출.
pub fn request_system_audio_permission() -> &'static str {
    match unsafe { native_request_system_audio_permission() } {
        0 => "authorized",
        1 => "denied",
        _ => "not_determined",
    }
}

/// 시스템 오디오 캡처 시작. 반환: 네이티브 CaptureResult(0=ok, 음수=실패/거부/미지원).
/// 스테일 스테이징을 먼저 제거해 이전 세션 잔여가 섞이지 않게 한다.
pub fn start_system_audio_capture() -> i32 {
    let staging = system_audio_staging_path();
    let _ = fs::remove_file(&staging);
    if let Some(parent) = staging.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let path = match CString::new(staging.to_string_lossy().as_bytes()) {
        Ok(c) => c,
        Err(_) => return -4,
    };
    unsafe { native_start_system_audio_capture(path.as_ptr()) }
}

/// 시스템 오디오 캡처 정지. 반환: 0=ok, 음수=미실행 등.
pub fn stop_system_audio_capture() -> i32 {
    unsafe { native_stop_system_audio_capture() }
}

/// 녹음 중 직전 버퍼 RMS — 실시간 레벨 미터용(frontend가 폴링해 마이크 레벨과 합성). 미실행 시 0.
pub fn system_audio_level() -> f32 {
    unsafe { native_system_audio_level() }
}

/// 마이크 캡처 시작. 반환: 네이티브 CaptureResult(0=ok, 음수=실패/미지원).
/// 스테일 스테이징을 먼저 제거해 이전 세션 잔여가 섞이지 않게 한다(시스템 오디오와 동일 패턴).
pub fn start_mic_capture() -> i32 {
    let staging = mic_staging_path();
    let _ = fs::remove_file(&staging);
    if let Some(parent) = staging.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let path = match CString::new(staging.to_string_lossy().as_bytes()) {
        Ok(c) => c,
        Err(_) => return -4,
    };
    let code = unsafe { native_start_mic_capture(path.as_ptr()) };
    // 마이크 캡처는 모든 녹음의 공통 진입점 — 성공 시에만 전원 관리(App Nap·유휴 슬립 방지) 활동을 건다.
    if code == 0 {
        unsafe { native_begin_recording_activity() }
    }
    code
}

/// 마이크 캡처 정지. 반환: 0=ok, 음수=미실행 등.
pub fn stop_mic_capture() -> i32 {
    unsafe { native_end_recording_activity() } // 멱등 — begin 안 걸렸어도 안전
    unsafe { native_stop_mic_capture() }
}

/// 녹음 중 직전 버퍼 RMS — 실시간 레벨 미터용(frontend가 폴링). 미실행 시 0.
pub fn mic_level() -> f32 {
    unsafe { native_mic_level() }
}

/// 세션 메타데이터의 단일 진실 원천 (`meeting.json`).
/// `time`은 캘린더 이벤트일 때만 채워진다.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct MeetingMeta {
    pub title: String,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub time: Option<String>,
    pub r#type: String,
    pub attendees: Vec<String>,
    pub agenda: String,
    pub source: String,
    /// 정밀 교정(text-correction) 여부 — 녹음 시작 설정의 토글값(**기본 ON=정밀, opt-out**). true면
    /// `/meeting` Phase-1이 text-correction 포함(전사본까지 교정), false면 생략(빠름). 신규 세션은
    /// 항상 명시 기록. 옛 meeting.json엔 없으며, 스킬은 "없음=정밀(기본)"으로 해석.
    #[serde(default)]
    pub detailed_correction: bool,
    /// 녹음 캡처 모드 — "mic"(마이크만) 또는 "mic+system"(원격회의 시스템 오디오 포함).
    /// create_session은 사용자 의도(토글)를 기록하고, convert_recording이 실제 캡처 결과로 교정한다
    /// (권한 거부·무음이면 "mic"). 옛 세션엔 없으며, 부재=마이크만으로 해석.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capture_mode: Option<String>,
}

pub fn create_session(meta: &MeetingMeta) -> Result<String, String> {
    let output_dir = output_dir();
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("output 디렉토리 생성 실패: {e}"))?;

    let timestamp = chrono_timestamp();
    let safe_title = sanitize_title(&meta.title);
    let dir_name = format!("{}_{}", timestamp, safe_title);
    let session_dir = output_dir.join(&dir_name);

    fs::create_dir_all(&session_dir)
        .map_err(|e| format!("세션 디렉토리 생성 실패: {e}"))?;

    let mut meta = meta.clone();
    if meta.date.is_empty() {
        meta.date = timestamp[..10].to_string();
    }

    let json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("meeting.json 직렬화 실패: {e}"))?;
    fs::write(session_dir.join("meeting.json"), json)
        .map_err(|e| format!("meeting.json 저장 실패: {e}"))?;

    Ok(session_dir.to_string_lossy().to_string())
}

fn read_meeting_title(session_dir: &std::path::Path) -> Option<String> {
    let raw = fs::read_to_string(session_dir.join("meeting.json")).ok()?;
    let meta: MeetingMeta = serde_json::from_str(&raw).ok()?;
    Some(meta.title)
}

/// meeting.json의 attendees 배열 (파일 없음·파싱 실패·필드 누락 시 빈 벡터).
/// 전사 prompt priming + 화자분리 max_speakers 계산에 쓰임.
///
/// meeting.json은 Rust(create_session)와 프론트(updateMeetingMeta)가 함께 쓰므로,
/// 전체 구조체 역직렬화에 기대지 않고 attendees 배열만 관대하게 추출한다 — 다른 필드가
/// 빠지거나 드리프트해도 attendees가 통째로 사라지지 않도록 (기존 동작과 동일한 leniency).
pub fn read_meeting_attendees(session_dir: &std::path::Path) -> Vec<String> {
    fs::read_to_string(session_dir.join("meeting.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("attendees")?
                .as_array()
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        })
        .unwrap_or_default()
}

/// publish.json의 `confluence.published` 필드만 읽는 경량 판정.
/// 파일 없거나 파싱 실패 = false (미발행). 모드 무관 단일 지점.
fn read_publish_published(session_dir: &std::path::Path) -> bool {
    let Ok(raw) = fs::read_to_string(session_dir.join("publish.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("confluence")?.get("published")?.as_bool())
        .unwrap_or(false)
}

/// transcribe.sh가 기록한 무음 판정. 파일 부재(기존 세션·정상 흐름)는 false.
fn read_no_speech(session_dir: &std::path::Path) -> bool {
    let Ok(raw) = fs::read_to_string(session_dir.join("transcribe_result.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("no_speech")?.as_bool())
        .unwrap_or(false)
}

/// 사용자 templates 디렉토리에 시드 가이드 복사. idempotent — 이미 있는 파일은 건너뜀.
/// 사용자 위치는 회의 유형 가이드의 단일 진실 원천이다.
pub fn seed_user_templates(app: &tauri::AppHandle) -> Result<(), String> {
    let user_dir = user_templates_dir();
    fs::create_dir_all(&user_dir)
        .map_err(|e| format!("templates 디렉토리 생성 실패: {e}"))?;

    let seed_dir = seed_templates_dir(app)?;
    if !seed_dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(&seed_dir).map_err(|e| format!("시드 디렉토리 읽기 실패: {e}"))?.flatten() {
        let src = entry.path();
        if src.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
        let Some(name) = src.file_name() else { continue; };
        let dest = user_dir.join(name);
        if dest.exists() { continue; }
        fs::copy(&src, &dest)
            .map_err(|e| format!("시드 복사 실패 ({}): {e}", name.to_string_lossy()))?;
    }

    Ok(())
}

/// 사용자 vocabulary.json을 시드(번들 동봉)에서 복사. idempotent — 이미 있으면 건너뜀.
/// 복사 후 사용자 위치가 용어 사전의 단일 진실 원천이 된다(앱에서 편집).
pub fn seed_user_vocabulary(app: &tauri::AppHandle) -> Result<(), String> {
    let dest = vocabulary_path();
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("vocabulary 디렉토리 생성 실패: {e}"))?;
    }
    let seed = resource_dir(app)?.join("vocabulary.json");
    if !seed.exists() {
        return Ok(());
    }
    fs::copy(&seed, &dest).map_err(|e| format!("vocabulary 시드 복사 실패: {e}"))?;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct MeetingTypeOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

/// 사용자 templates 디렉토리에서 가이드 목록 + frontmatter 메타를 파싱해 UI 옵션 생성.
/// `auto`는 디렉토리에 파일이 없는 가상 옵션이라 호출자가 별도로 prepend 한다.
pub fn list_meeting_types() -> Result<Vec<MeetingTypeOption>, String> {
    let dir = user_templates_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut options = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("templates 디렉토리 읽기 실패: {e}"))?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
        let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) else { continue; };

        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let fm = parse_frontmatter(&raw);
        let id = fm.get("name").cloned().unwrap_or_else(|| file_stem.to_string());
        let label = fm.get("label").cloned().unwrap_or_else(|| id.clone());
        let description = fm.get("description").cloned().unwrap_or_default();
        options.push(MeetingTypeOption { id, label, description });
    }

    options.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(options)
}

/// `---` 사이의 single-line `key: value` 항목만 추출.
/// `summary: |` 같은 multi-line block scalar의 본문(들여쓴 라인)은 무시한다.
fn parse_frontmatter(content: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut lines = content.lines();
    if lines.next() != Some("---") { return map; }
    for line in lines {
        if line == "---" { break; }
        let first = line.chars().next();
        if !matches!(first, Some(c) if c.is_ascii_alphabetic() || c == '_') { continue; }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            if v.is_empty() || v == "|" || v == ">" { continue; }
            let v = v.trim_matches('"').trim_matches('\'');
            map.insert(k.trim().to_string(), v.to_string());
        }
    }
    map
}

// ─── 회의 유형 가이드 생성/조정 (AI 템플릿) ──────────────────────────
//
// `/template` 스킬이 생성·조정한 가이드를 staging → commit(게이트 검증) → live로 옮긴다.
// 입력(폼/지시)은 셸 이스케이프 붕괴를 피해 env가 아니라 `request.json` 파일로 전달한다.

/// 유형명(=파일 stem, frontmatter `name`) 검증. 파일명·식별자로 안전한 slug만 허용.
/// 소문자·숫자·하이픈만 (시드 `presentation`/`note`/`review`와 동일 규약), traversal 차단.
fn validate_type_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("유형 이름이 비어 있습니다".into());
    }
    if name.len() > 64 {
        return Err("유형 이름이 너무 깁니다 (최대 64자)".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!("유형 이름은 소문자·숫자·하이픈만 허용됩니다: {name}"));
    }
    Ok(())
}

/// AI 생성물의 staging 위치. 점-디렉토리라 `list_meeting_types`의 top-level `*.md` 순회에서 제외된다.
fn staging_dir() -> PathBuf {
    user_templates_dir().join(".staging")
}

/// frontmatter에 `summary: |`(또는 `>`) 블록이 있고 본문(들여쓴 비어있지 않은 라인)이 존재하는지 검사.
/// `parse_frontmatter`는 multi-line block scalar 본문을 무시하므로 summary는 여기서 별도 검증한다.
/// summary는 auto 매칭의 핵심이라 누락·빈 블록을 게이트에서 막는다.
fn has_summary_block(content: &str) -> bool {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return false;
    }
    let mut in_summary = false;
    for line in lines {
        if line == "---" {
            break;
        }
        if in_summary {
            // 들여쓴 비어있지 않은 라인이 하나라도 있으면 본문 있음
            if line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
                return true;
            }
            // 들여쓰기 없는 새 키 → summary 블록 종료 (본문 없었음)
            if !line.is_empty() && !line.starts_with(char::is_whitespace) {
                in_summary = false;
            }
        }
        if !in_summary {
            if let Some(rest) = line.strip_prefix("summary:") {
                let t = rest.trim();
                if t == "|" || t == ">" || t == "|-" || t == ">-" {
                    in_summary = true;
                }
            }
        }
    }
    false
}

/// 생성물 품질 게이트 — frontmatter가 UI·auto 매칭에 필요한 형태를 갖췄는지 검증.
/// 성공 시 `name`을 반환. parse_frontmatter(single-line) 제약을 강제해 목록·매칭이 깨지지 않게 한다.
fn validate_template_frontmatter(content: &str) -> Result<String, String> {
    let fm = parse_frontmatter(content);
    let name = fm
        .get("name")
        .cloned()
        .ok_or("frontmatter에 name 필드가 없습니다")?;
    validate_type_name(&name)?;
    if fm.get("label").map_or(true, |s| s.is_empty()) {
        return Err("frontmatter에 label 필드가 없습니다".into());
    }
    if fm.get("description").is_none() {
        return Err("frontmatter에 description 필드가 없습니다".into());
    }
    if !has_summary_block(content) {
        return Err("frontmatter에 summary: | 블록이 없거나 비어 있습니다 (auto 매칭에 필수)".into());
    }
    // 예시 회의록 섹션 — 가독성·few-shot 품질 앵커. `## …예시…` 헤딩 존재를 요구한다.
    let has_example = content
        .lines()
        .any(|l| l.starts_with("## ") && l.contains("예시"));
    if !has_example {
        return Err("본문에 '## 예시 회의록' 섹션이 없습니다 (결과물 미리보기·품질에 필수)".into());
    }
    Ok(name)
}

/// 유형 가이드 원문(.md) 읽기. UI 카드의 "원문 보기"·조정 모드 컨텍스트에 쓰임.
pub fn read_meeting_type(name: &str) -> Result<Option<String>, String> {
    validate_type_name(name)?;
    let path = user_templates_dir().join(format!("{name}.md"));
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("유형 가이드 읽기 실패: {e}"))
}

/// 사용자가 직접 편집한 가이드 원문을 게이트 검증 후 live `{target}.md`에 저장 (담당자 직접 수정용).
/// 편집으로 유형 이름(name)을 바꾸는 건 막는다 — 다른 파일이 되어 원본이 orphan으로 남기 때문.
pub fn save_meeting_type(target: &str, content: &str) -> Result<(), String> {
    validate_type_name(target)?;
    let name = validate_template_frontmatter(content)?;
    if name != target {
        return Err(format!(
            "유형 이름(name)은 편집으로 바꿀 수 없습니다. '{target}' 그대로 두세요."
        ));
    }
    let dest = user_templates_dir().join(format!("{target}.md"));
    fs::write(&dest, content).map_err(|e| format!("유형 가이드 저장 실패: {e}"))
}

/// 유형 가이드 삭제. 시드 유래 유형도 삭제 가능 (seed_user_templates가 idempotent라 되살아나지 않음).
pub fn delete_meeting_type(name: &str) -> Result<(), String> {
    validate_type_name(name)?;
    let path = user_templates_dir().join(format!("{name}.md"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("유형 가이드 삭제 실패: {e}"))?;
    }
    Ok(())
}

/// 생성/조정 요청을 staging의 `request.json`으로 기록 (스킬이 읽는 입력). 이전 결과물은 제거해
/// 신호 후 프론트가 항상 새 결과를 읽도록 한다.
pub fn write_template_request(json: &str) -> Result<(), String> {
    let dir = staging_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("staging 디렉토리 생성 실패: {e}"))?;
    let _ = fs::remove_file(dir.join("result.md"));
    fs::write(dir.join("request.json"), json).map_err(|e| format!("request.json 쓰기 실패: {e}"))
}

/// 스킬이 staging에 기록한 생성물(`result.md`) 읽기 — 미리보기용.
pub fn read_staged_meeting_type() -> Result<Option<String>, String> {
    let staged = staging_dir().join("result.md");
    if !staged.exists() {
        return Ok(None);
    }
    fs::read_to_string(&staged)
        .map(Some)
        .map_err(|e| format!("staging 결과 읽기 실패: {e}"))
}

/// staging 결과를 게이트 검증 후 live `{name}.md`로 확정. 반환값: 확정된 유형명.
/// `overwrite=false`(create)는 동명 유형이 있으면 거부, `true`(adjust)는 덮어쓴다.
pub fn commit_meeting_type(overwrite: bool) -> Result<String, String> {
    let staged = staging_dir().join("result.md");
    let content =
        fs::read_to_string(&staged).map_err(|e| format!("staging 결과를 읽을 수 없습니다: {e}"))?;
    let name = validate_template_frontmatter(&content)?;
    let dest = user_templates_dir().join(format!("{name}.md"));
    if dest.exists() && !overwrite {
        return Err(format!("이미 있는 유형입니다: {name}"));
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&dest, &content).map_err(|e| format!("유형 가이드 저장 실패: {e}"))?;
    let _ = fs::remove_file(&staged);
    Ok(name)
}

/// staging 전체 정리 (취소·화면 진입 시 stale 제거). request.json·result.md 모두 제거.
pub fn clear_staged_meeting_type() -> Result<(), String> {
    let dir = staging_dir();
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(())
}

/// loudnorm 1패스 측정 결과 (ffmpeg print_format=json의 input_* 필드).
/// 2패스 apply에서 measured_* 인자로 박아 "측정된 단일 정적 게인"만 적용한다(linear=true).
#[derive(Deserialize)]
struct LoudnormStats {
    input_i: String,
    input_tp: String,
    input_lra: String,
    input_thresh: String,
    target_offset: String,
}

impl LoudnormStats {
    /// 측정값이 2패스 apply에 안전하게 쓸 수 있는지 검사.
    /// 완전 디지털 무음 소스(원격 내내 음소거 → tap이 0 PCM 전달)는 loudnorm이 input_i/tp="-inf",
    /// offset="inf"를 뱉는다. 이 값을 measured_*에 박으면 ffmpeg가 범위(measured_i [-99,0] 등)를
    /// 벗어났다며 믹스 패스를 통째로 실패시켜 recording.wav가 안 생긴다(녹음 손실). 비-finite·범위 밖이면
    /// false → 호출부가 그 소스 정규화를 생략(raw 믹스). 무음은 정규화할 신호가 없으므로 손실 없음.
    fn is_usable(&self) -> bool {
        let ok = |s: &str, lo: f64, hi: f64| {
            s.parse::<f64>()
                .map(|v| v.is_finite() && v >= lo && v <= hi)
                .unwrap_or(false)
        };
        ok(&self.input_i, -99.0, 0.0)
            && ok(&self.input_tp, -99.0, 99.0)
            && ok(&self.input_lra, 0.0, 99.0)
            && ok(&self.input_thresh, -99.0, 0.0)
            && ok(&self.target_offset, -99.0, 99.0)
    }

    /// 2패스 apply용 loudnorm 필터 문자열 (measured_* + linear=true). 타깃 -16 LUFS / TP -1.5.
    ///
    /// 타깃 LRA는 측정 LRA와 같게 둔다(범위 [1,50] 클램프). loudnorm은 측정 LRA가 타깃 LRA보다
    /// 크면 linear=true여도 **조용히 dynamic 압축으로 폴백**한다(실측: 소스 LRA 12 / 타깃 11이면
    /// 12dB 다이내믹 레인지가 6.5dB로 압축). dynamic은 다이내믹스 압축 + 노이즈 부스트라 우리가
    /// 피하려는 동작(project_no_denoising)이 새어든다. measured==target이면 폴백 조건(measured>target)을
    /// 안 건드려 linear가 유지된다(ffmpeg-normalize의 keep_loudness_range_target과 같은 처리).
    fn apply_filter(&self) -> String {
        let target_lra = self.input_lra.parse::<f64>().unwrap_or(7.0).clamp(1.0, 50.0);
        format!(
            "loudnorm=I=-16:TP=-1.5:LRA={target_lra}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
            self.input_i, self.input_tp, self.input_lra, self.input_thresh, self.target_offset
        )
    }
}

/// loudnorm 1패스: 한 소스의 라우드니스를 측정한다. apply 체인과 동일한 prefilter(HPF·mono)를
/// 그대로 거쳐 측정해야 2패스에서 같은 게인이 나온다. 실패(파일 손상·무음·ffmpeg 에러·JSON 파싱 실패)는
/// None 반환 → 호출부가 그 소스 정규화를 생략(graceful, 변환 자체는 진행).
///
/// dual_mono는 의도적으로 쓰지 않는다: 마이크·시스템 모두 mono로 다운믹스해 mono 한 채널로 합치므로
/// (stereo 재생 아님), mono를 stereo 재생 기준으로 -3dB 보정하는 dual_mono=true는 오히려
/// 마이크를 시스템보다 3dB 작게 만들어 균형을 깨뜨린다(실측 확인). 둘 다 mono 기준 -16 LUFS로 맞춘다.
fn measure_loudnorm(ffmpeg: &std::path::Path, input: &std::path::Path, hpf: bool) -> Option<LoudnormStats> {
    let mut chain = String::new();
    if hpf {
        chain.push_str("highpass=f=70,");
    }
    chain.push_str("aformat=channel_layouts=mono,");
    chain.push_str("loudnorm=I=-16:TP=-1.5:LRA=11");
    chain.push_str(":print_format=json");

    let output = Command::new(ffmpeg)
        .args(["-i", input.to_str()?, "-af", &chain, "-f", "null", "-"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // print_format=json은 stderr 끝에 JSON 객체 하나를 출력한다. 첫 '{' ~ 마지막 '}'를 잘라 파싱.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let start = stderr.find('{')?;
    let end = stderr.rfind('}')?;
    let stats: LoudnormStats = serde_json::from_str(&stderr[start..=end]).ok()?;
    // 무음 소스의 -inf/inf 측정값을 걸러 apply 패스 실패(녹음 손실)를 막는다(is_usable 주석 참조).
    stats.is_usable().then_some(stats)
}

/// 마이크 녹음(네이티브 캡처 48k mono WAV)을 whisper 입력 WAV(16k mono, PCM 16bit)로 단일 변환.
fn convert_mic_only(ffmpeg: &std::path::Path, mic_path: &std::path::Path, wav_path: &std::path::Path) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args([
            "-i", mic_path.to_str().unwrap(),
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            "-y", wav_path.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("ffmpeg 실행 실패: {e}"))?;
    if !output.status.success() {
        return Err(format!("ffmpeg 변환 실패: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// 마이크 녹음(네이티브 캡처 48k mono WAV 스테이징)을 whisper 입력 WAV(16k mono)로 변환. 마이크와
/// 시스템 오디오 모두 녹음 중 app_data_dir 스테이징에 기록되며, 종료 후 이 함수가 둘을 읽어 처리한다.
/// 시스템 오디오는 항상 캡처를 시도하므로(OS 권한이 게이트) 스테이징 파일을 보고 3-way로 분기한다:
///   1. 스테이징이 비었거나(권한 거부) **실제 원격 발화가 없음**(대면/무음, system_has_speech=false)
///      → **마이크만**(capture_mode=mic). 에코·믹스 로직을 아예 타지 않는다.
///   2. 원격 있음 + 마이크가 그걸 에코로 담음(스피커 → mic_echoes_system) → **마이크만**(capture_mode=mic+system).
///      tap을 섞으면 더블링/울림(comb-filter)으로 전사가 망가지므로(실측) 더블링을 원천 회피.
///   3. 원격 있음 + 마이크에 에코 없음(헤드폰) → 마이크+시스템 오프라인 믹스(loudnorm, capture_mode=mic+system).
///      tap이 유일한 원격 소스.
pub fn convert_recording(app: &tauri::AppHandle, session_dir: &str) -> Result<(), String> {
    let session_path = PathBuf::from(session_dir);
    let mic_path = mic_staging_path();
    let wav_path = session_path.join("recording.wav");
    // 앱 동봉 ffmpeg (PATH 의존 제거). dev/release 모두 resource_dir/bin/ffmpeg를 가리킨다.
    let ffmpeg = resource_dir(app)?.join("bin/ffmpeg");

    if !mic_path.exists() {
        return Err("마이크 녹음 파일이 없습니다".into());
    }

    let staging = system_audio_staging_path();
    // 스테이징에 실제 데이터가 있을 때만 믹스. 헤더만 있는 ~44바이트는 권한거부/무콜백 → 제외.
    // byte 임계로 "캡처 미전달"(거부)과 "캡처됨(무음 포함)"을 가른다 — 무음은 섞어도 무해(mic+0=mic).
    let staging_has_audio = fs::metadata(&staging).map(|m| m.len() > 4096).unwrap_or(false);

    if staging_has_audio {
        // 분류: (1) 시스템에 실제 원격 발화가 있나(없으면 대면/무음 → 마이크만, 에코·믹스 로직 안 탐),
        // (2) 있으면 마이크가 그걸 에코로 담나(스피커 → 마이크만 / 헤드폰 → 믹스). 판정용 16k mono raw 추출.
        let mic_raw = session_path.join("~mic16.raw");
        let sys_raw = session_path.join("~sys16.raw");
        let to_raw = |src: &std::path::Path, dst: &std::path::Path| {
            Command::new(&ffmpeg)
                .args([
                    "-i", src.to_str().unwrap(),
                    "-ar", "16000", "-ac", "1", "-f", "s16le", "-y", dst.to_str().unwrap(),
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        // (1) 시스템에 실제 발화? 무음(대면)이면 has_remote=false → 아래 && 단락이 short-circuit돼
        //     mic_raw는 추출조차 안 하고 마이크-only로 간다(대면을 먼저 걸러냄).
        let has_remote = to_raw(&staging, &sys_raw) && system_has_speech(&sys_raw);
        // (2) 원격이 있을 때만 마이크 에코 여부(스피커 재유입) 판정.
        let speaker_echo =
            has_remote && to_raw(&mic_path, &mic_raw) && mic_echoes_system(&mic_raw, &sys_raw);
        let _ = fs::remove_file(&mic_raw);
        let _ = fs::remove_file(&sys_raw);

        if speaker_echo || !has_remote {
            // 마이크만 쓰는 두 경우:
            //  · !has_remote(대면/무음): 시스템에 원격이 없다 → 섞을 게 없다. 마이크만.
            //  · speaker_echo(스피커 재유입): 마이크에 이미 원격이 들어와 tap을 섞으면 두 복사본이 겹쳐
            //    comb-filtering/더블링 → whisper 전사가 간헐 파괴(실측 2026-06-28). 싼 신호처리로 해결 안 됨
            //    (ducking 잔여 울림, 선형 AEC −4.6dB만 — 둘 다 실측). 더블링을 원천 회피: tap 버리고 마이크만.
            //    마이크가 원격(에코)+로컬을 다 담아 손실 없음. (tap 클린 음질까지면 신경망 AEC 필요 — 후속.)
            //    상관계수 기반이라 내장/외부/회의실 스피커 구분 없이 device-agnostic.
            convert_mic_only(&ffmpeg, &mic_path, &wav_path)?;
        } else {
            // 헤드폰 등(마이크에 원격 없음 → tap이 유일한 원격 소스). 마이크·시스템을 합치기 전에 per-source
            // 2-pass loudnorm(linear)으로 -16 LUFS에 맞춰 음량 불균형(낮은 마이크 게인 vs 디지털 풀레벨 원격)을
            // 해소한다. linear 2-pass = 측정된 단일 정적 게인만 → 다이내믹스·노이즈플로어·SNR 보존(펌핑 없음).
            // single-pass loudnorm·dynaudnorm·AGC는 무음 노이즈 부스트·펌핑으로 전사·화자분리 악화 → 금지
            // (project_no_denoising). 정규화는 소스 분리·48k에서만 유효(16k/mono 뒤로 미루면 정확도 저하 +
            // 합친 뒤 분리 불가)하므로 여기서 한다. 마이크엔 가벼운 70Hz HPF(럼블 제거). 헤드폰이라 에코 없어
            // 더블링도 없다(이 경로엔 ducking/AEC 불필요).
            let mic_branch = match measure_loudnorm(&ffmpeg, &mic_path, true) {
                Some(m) => format!(
                    "[0:a]highpass=f=70,aformat=channel_layouts=mono,{}[a0]",
                    m.apply_filter()
                ),
                None => "[0:a]highpass=f=70,aformat=channel_layouts=mono[a0]".to_string(),
            };
            let sys_branch = match measure_loudnorm(&ffmpeg, &staging, false) {
                Some(m) => format!("[1:a]aformat=channel_layouts=mono,{}[a1]", m.apply_filter()),
                None => "[1:a]aformat=channel_layouts=mono[a1]".to_string(),
            };
            // normalize=0: 입력 수로 음량을 안 나눔(나누면 whisper에 너무 작아짐). 합산 피크는 alimiter로 방지.
            // duration=longest: 두 클럭의 미세 길이차(드리프트 ~25ms/30분)는 짧은 쪽을 패딩해 흡수.
            let filter = format!(
                "{mic_branch};{sys_branch};\
                 [a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97[mix]"
            );
            let output = Command::new(&ffmpeg)
                .args([
                    "-i", mic_path.to_str().unwrap(),
                    "-i", staging.to_str().unwrap(),
                    "-filter_complex", filter.as_str(),
                    "-map", "[mix]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                    "-y", wav_path.to_str().unwrap(),
                ])
                .output()
                .map_err(|e| format!("ffmpeg 믹스 실행 실패: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("ffmpeg 믹스 실패: {stderr}"));
            }
        }

        // 진단 모드: 원본 스템을 세션에 보존(마이크 48k wav + 시스템 48k wav). 분리 트랙으로 에코·음량을
        // tap 단독 vs 믹스로 비교하거나 향후 AEC 입력으로 쓴다. 기본은 보존 안 함. 무음 시스템은 보존 의미 없음.
        if should_keep_recording() && has_remote {
            let _ = fs::copy(&mic_path, session_path.join("recording_mic.wav"));
            let _ = fs::copy(&staging, session_path.join("recording_system.wav"));
        }
        let _ = fs::remove_file(&mic_path);
        let _ = fs::remove_file(&staging);
        // 원격이 결과에 포함되면 mic+system, 대면/무음이면 mic.
        set_capture_mode(
            &session_path,
            if has_remote { CAPTURE_MODE_MIC_SYSTEM } else { CAPTURE_MODE_MIC },
        );
    } else {
        // 마이크만 — 시스템 오디오 미포착(거부·무음·대면).
        convert_mic_only(&ffmpeg, &mic_path, &wav_path)?;
        let _ = fs::remove_file(&mic_path);
        let _ = fs::remove_file(&staging);
        set_capture_mode(&session_path, CAPTURE_MODE_MIC);
    }

    Ok(())
}

/// meeting.json의 capture_mode 필드만 patch (다른 필드 보존). 실패는 비치명적.
fn set_capture_mode(session_path: &std::path::Path, mode: &str) {
    let path = session_path.join("meeting.json");
    let Ok(raw) = fs::read_to_string(&path) else { return };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("capture_mode".to_string(), serde_json::Value::String(mode.to_string()));
        if let Ok(s) = serde_json::to_string_pretty(&v) {
            let _ = fs::write(&path, s);
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ResumableSession {
    pub path: String,
    pub title: String,
    pub date: String,
    pub time: String,
    pub steps: SessionSteps,
}

#[derive(Serialize, Clone)]
pub struct SessionSteps {
    pub transcribed: bool,
    pub diarized: bool,
    pub corrected: bool,
    pub notes_written: bool,
    pub published: bool,
    /// 녹음에 발화가 없어(무음) diarize·회의록을 건너뛴 세션.
    /// transcribe_result.json에서 파생. frontend가 "발화 없음" 상태 표시.
    pub no_speech: bool,
}

/// 세션 목록 조회 (완료/미완료 모두). 미완료는 재개, 완료는 다시 보기 용도.
pub fn find_resumable_sessions() -> Result<Vec<ResumableSession>, String> {
    let output_dir = output_dir();

    if !output_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    let mut entries: Vec<_> = fs::read_dir(&output_dir)
        .map_err(|e| format!("output 디렉토리 읽기 실패: {e}"))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // 최신순

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if !path.is_dir() || name.len() < 10 {
            continue;
        }

        // 유효 세션 판정 — 녹음 원본이 있거나, 이미 전사된 흔적(segments.json)이 있어야 함.
        // release는 화자분리 후 recording.wav를 자동 삭제(프라이버시)하므로, 오디오가 없어도
        // 전사 산출물이 있으면 완료 세션으로 본다(cleanup_recording_audio 참조).
        if !path.join("recording.wav").exists()
            && !path.join("segments.json").exists()
        {
            continue;
        }

        let title = read_meeting_title(&path)
            .unwrap_or_else(|| name.get(20..).unwrap_or(&name).replace('_', " ").to_string());

        let date = name.get(..10).unwrap_or("").to_string();
        let time = name.get(11..16).unwrap_or("").replace('-', ":");

        // 모든 단계 판정은 "파일 존재 + 비어있지 않음"으로 일관 — 빈 파일은 실패 케이스로 간주.
        let nonempty = |name: &str| -> bool {
            let p = path.join(name);
            p.exists() && fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
        };

        let steps = SessionSteps {
            transcribed: nonempty("segments.json"),
            diarized: nonempty("transcript.txt"),
            // 교정본 = LLM sub-agent + sidecar 적용 결과물 모두 존재해야 완료
            corrected: nonempty("transcript_corrected.txt") && nonempty("speaker_mapping.json"),
            notes_written: nonempty("meeting-notes.md"),
            // 발행 마킹은 publish.json의 confluence.published 필드 (모드 무관 단일 지점).
            // 1회성 마이그레이션(scripts/) 전 confluence-url.txt만 있는 세션은 false로 보임 — 의도.
            published: read_publish_published(&path),
            no_speech: read_no_speech(&path),
        };

        sessions.push(ResumableSession {
            path: path.to_string_lossy().to_string(),
            title,
            date,
            time,
            steps,
        });
    }

    Ok(sessions)
}

/// 세션 디렉토리 삭제
pub fn delete_session(session_path: &str) -> Result<(), String> {
    let path = PathBuf::from(session_path);
    if path.exists() && path.is_dir() {
        fs::remove_dir_all(&path)
            .map_err(|e| format!("세션 삭제 실패: {e}"))?;
    }
    Ok(())
}

/// 세션 디렉토리에서 `keep` 화이트리스트 외의 파일을 전부 삭제하는 공용 헬퍼.
/// 보존 화이트리스트 방식 — 산출물 종류가 늘어도(edits·bak 등) 누락 없이 정리되고,
/// 옛 명세가 새 산출물에 잘못 매칭되는 stale도 막는다. 하위 디렉토리는 건드리지 않으며,
/// 재처리/재작성으로 산출물이 재생성되므로 백업 없이 삭제.
fn reset_session_keeping(session_path: &str, keep: &[&str]) -> Result<(), String> {
    let path = PathBuf::from(session_path);
    if !path.exists() || !path.is_dir() {
        return Err("세션 디렉토리를 찾을 수 없습니다".into());
    }
    let entries = fs::read_dir(&path).map_err(|e| format!("세션 디렉토리 읽기 실패: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("디렉토리 항목 읽기 실패: {e}"))?;
        let p = entry.path();
        if !p.is_file() {
            continue; // 하위 디렉토리는 보존 (현재 세션 구조엔 없지만 방어적)
        }
        let fname = entry.file_name();
        let fname = fname.to_string_lossy();
        if keep.contains(&fname.as_ref()) {
            continue;
        }
        fs::remove_file(&p).map_err(|e| format!("{fname} 삭제 실패: {e}"))?;
    }
    Ok(())
}

/// dev 전용: 녹음 끝난 시점으로 세션 초기화 — 녹음 원본·메타·녹음 메모만 남기고
/// 나머지 처리 산출물을 전부 삭제한다. 앱이 "오디오 처리 시작" 상태로 복원돼
/// 전사→화자분리를 다시 돌릴 수 있다(화자분리 파라미터 변경 후 재실행 등).
pub fn reset_session_to_recording(session_path: &str) -> Result<(), String> {
    // 보존: 녹음 원본·회의 메타(재처리에 필요)·녹음 메모(화자 힌트). 그 외는 전부 산출물.
    reset_session_keeping(
        session_path,
        &["recording.wav", "meeting.json", "notes.json"],
    )
}

/// dev 전용: 화자분리까지 완료된 시점으로 세션 초기화 — 전사·화자분리 산출물은 보존하고
/// `/meeting`(AI 후보정·회의록·발행) 산출물만 삭제한다. 회의록 작성 단계를 깨끗한 상태로
/// 다시 돌릴 때 사용(느린 전사·화자분리를 재실행하지 않아 defer 경로 테스트에 유용).
pub fn reset_session_to_diarized(session_path: &str) -> Result<(), String> {
    // 보존: 녹음 시점 보존 목록 + 전사(segments/whisper/result)·화자분리(diarize/recording/transcript)
    // 산출물 + 처리 로그. 삭제: transcript_corrected·*_edits·speaker_mapping·meeting-notes(.bak)·publish.
    reset_session_keeping(
        session_path,
        &[
            "recording.wav",
            "meeting.json",
            "notes.json",
            "pipeline.log",
            "segments.json",
            "recording_whisper.json",
            "transcribe_result.json",
            "diarize.json",
            "recording.json",
            "transcript.txt",
        ],
    )
}

/// JS에서 호출 가능한 public wrapper.
/// 프론트엔드는 이 값을 Claude Code의 cwd로 사용 — .claude/skills/가 여기 있음
/// (sandbox 등 설정은 cwd projectSettings 대신 격리 CLAUDE_CONFIG_DIR의 user settings로 분리됨).
/// dev에선 워크스페이스 (개발자가 .claude/skills를 직접 편집 → 즉시 반영),
/// release에선 번들 Resources/ (새 dmg = 새 skills 자동 적용).
pub fn get_app_dir(app: &tauri::AppHandle) -> Result<String, String> {
    Ok(resource_dir(app)?.to_string_lossy().into_owned())
}

#[derive(Serialize, Clone)]
pub struct DepsStatus {
    pub installed: bool,
    pub missing: Vec<String>,
    pub app_dir: Option<String>,
}

/// 의존성 설치 상태 확인 — 핵심 자산이 모두 있는지 검증.
/// 번들된 리소스(bin/*, models/pyannote)는 항상 존재해야 정상; venv만 사용자 setup 대상.
pub fn check_dependencies(app: &tauri::AppHandle) -> DepsStatus {
    let resource = resource_dir(app).ok();
    let mut missing = Vec::new();

    if let Some(ref dir) = resource {
        if !dir.join("bin/whisper-cli").exists() { missing.push("whisper-cli".into()); }
        if !dir.join("bin/ffmpeg").exists() { missing.push("ffmpeg".into()); }
        if !dir.join("bin/diarize").exists() { missing.push("diarize".into()); }
        if !dir.join("bin/whisper-parse").exists() { missing.push("whisper-parse".into()); }
        if !dir.join("bin/apply-edits").exists() { missing.push("apply-edits".into()); }
        if !dir.join("bin/libNative.dylib").exists() { missing.push("libNative.dylib".into()); }
        // 화자분리 모델은 앱 번들 동봉 (CC-BY-4.0 — build-binaries.sh가 배치)
        if !dir.join("models/pyannote/config.yaml").exists() { missing.push("pyannote model".into()); }
    } else {
        missing.push("resource_dir".into());
    }
    // venv + Whisper 모델은 사용자 데이터 영역(Application Support).
    // install.sh가 도중 중단되어도 다음 실행 시 SetupScreen이 다시 노출되도록 둘 다 검증.
    if !venv_dir().join("bin/python3").exists() { missing.push("pyannote.audio".into()); }
    if !models_dir().join("ggml-large-v3-turbo-q8_0.bin").exists() { missing.push("whisper model".into()); }
    // 로컬 LLM(mlx) 선택 시 회의록 모델도 필수 — 없으면 SetupScreen이 다시 노출돼 다운로드.
    if read_active_cli().as_deref() == Some("mlx") && !local_model_present() {
        missing.push("로컬 AI 모델".into());
    }

    let app_dir = resource.map(|p| p.to_string_lossy().into_owned());
    DepsStatus {
        installed: missing.is_empty() && app_dir.is_some(),
        missing,
        app_dir,
    }
}

/// 사용자의 로그인 쉘에서 실제 PATH를 가져옴 (앱 실행 중 캐시).
/// VS Code·shell-env와 같은 방식: 로그인 인터랙티브 셸을 띄워 마커로 PATH만 추출(neofetch 등
/// 셸 시작 출력 오염 제거). 버전매니저 경로를 열거하지 않고 로그인 셸이 올린 PATH를 신뢰하되,
/// nvm default 한 개만 안전망으로 덧붙인다(셸 설정이 nvm을 PATH에 못 올린 경우 codex 등 누락 방지).
pub fn get_user_shell_path() -> String {
    // 로그인 셸 캡처만 캐시한다(셸을 1회 기동하므로 비쌈). rc 파일은 프로세스 수명 중
    // 바뀌지 않으므로 이 부분은 캐시가 안전하다.
    static CAPTURED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let mut path = CAPTURED
        .get_or_init(|| capture_shell_path().unwrap_or_else(fallback_shell_path))
        .clone();
    // 알려진 설치 위치 안전망은 매 호출 재평가한다(캡처에 없을 때만 뒤에 덧붙여 기존 우선순위 보존):
    // curl/native 인스톨러 → ~/.local/bin, npm node CLI → nvm default bin.
    // 이 디렉토리들은 런타임에 생길 수 있어(예: 온보딩 중 claude 설치) 캐시하면 안 된다 —
    // 캐시하면 설치 직후 같은 프로세스의 감지가 앱 재시작 전까지 실패한다. 둘 다 디렉토리
    // stat·작은 파일 1회 read라 저렴하므로 매번 현재 존재 여부를 본다. 버전매니저 전체
    // 열거 같은 추측성 하드코딩은 하지 않는다.
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    ensure_dir_in_path(&mut path, home.join(".local/bin"));
    if let Some(bin) = nvm_default_bin() {
        ensure_dir_in_path(&mut path, bin);
    }
    path
}

/// 존재하는 디렉토리를 PATH에 아직 없을 때만 뒤에 덧붙인다(우선순위 보존).
fn ensure_dir_in_path(path: &mut String, dir: PathBuf) {
    if dir.is_dir() {
        let s = dir.to_string_lossy();
        if !path.split(':').any(|p| p == s) {
            path.push(':');
            path.push_str(&s);
        }
    }
}

fn fallback_shell_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/.cargo/bin:/usr/bin:/bin")
}

/// 로그인 인터랙티브 셸의 $PATH를 제어문자 마커(\x01…\x02)로 감싸 추출(shell-env/VS Code 방식).
/// `node -v`로 lazy 버전매니저(nvm/fnm 등)를 한 번 깨운 뒤 PATH를 읽어 미로드 상태도 가능한 한 반영.
/// `echo $PATH`는 neofetch 등 셸 시작 출력에 묻혀 오염되므로 printf 마커 사이만 신뢰한다.
fn capture_shell_path() -> Option<String> {
    let mut shells: Vec<String> = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            shells.push(shell);
        }
    }
    shells.push("/bin/zsh".into());
    shells.push("/bin/bash".into());

    let script = r#"node -v >/dev/null 2>&1 || true; printf '\001%s\002' "$PATH""#;
    for shell in &shells {
        if let Ok(output) = Command::new(shell)
            .args(["-ilc", script])
            .env("DISABLE_AUTO_UPDATE", "true") // oh-my-zsh 등 자동 업데이트 방지
            .output()
        {
            if output.status.success() {
                let out = String::from_utf8_lossy(&output.stdout);
                if let (Some(a), Some(b)) = (out.find('\u{1}'), out.find('\u{2}')) {
                    if a < b {
                        let path = out[a + 1..b].trim().to_string();
                        if !path.is_empty() {
                            return Some(path);
                        }
                    }
                }
            }
        }
    }
    None
}

/// nvm default 버전의 node bin 디렉토리(존재할 때만). codex 등 npm 글로벌 CLI가 여기 깔린다.
/// 전체 버전 열거는 하지 않음(오래된 버전 잡힘 방지) — 사용자의 .zshenv가 쓰는 default 한 개만.
/// `lts/*` 같은 별칭이면 None(로그인 셸 PATH에 의존). 버전 형태("22.19.0"/"v22.19.0")만 직접 해석.
fn nvm_default_bin() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var("HOME").ok()?);
    let nvm_dir = home.join(".nvm");
    let alias = fs::read_to_string(nvm_dir.join("alias/default")).ok()?;
    let ver = alias.trim();
    if ver.is_empty() {
        return None;
    }
    let dir = if ver.starts_with('v') {
        ver.to_string()
    } else {
        format!("v{ver}")
    };
    let bin = nvm_dir.join("versions/node").join(dir).join("bin");
    bin.is_dir().then_some(bin)
}

fn chrono_timestamp() -> String {
    use chrono::{FixedOffset, Utc};
    let kst = FixedOffset::east_opt(9 * 3600).unwrap();
    Utc::now().with_timezone(&kst).format("%Y-%m-%d_%H-%M-%S").to_string()
}

/// 회의록 본문(meeting-notes.md)을 타임스탬프 백업으로 이름 바꾸고 원본 자리는 비운다.
/// 유형 변경으로 회의록을 재작성할 때 사용. 백업은 같은 디렉토리에 `meeting-notes.bak.{ts}.md`.
/// 원본이 없으면 Ok(None) — 호출자가 새로 작성될 거라 가정.
pub fn backup_meeting_notes(session_dir: &str) -> Result<Option<String>, String> {
    let dir = std::path::PathBuf::from(session_dir);
    let src = dir.join("meeting-notes.md");
    if !src.exists() {
        return Ok(None);
    }
    let ts = chrono_timestamp();
    let dest = dir.join(format!("meeting-notes.bak.{ts}.md"));
    fs::rename(&src, &dest)
        .map_err(|e| format!("회의록 백업 실패: {e}"))?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

fn sanitize_title(title: &str) -> String {
    let mut result: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-'
                || ('\u{AC00}'..='\u{D7AF}').contains(&c)
                || ('\u{3131}'..='\u{318E}').contains(&c)
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    while result.contains("__") {
        result = result.replace("__", "_");
    }
    result.trim_matches('_').to_string()
}
