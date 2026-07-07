// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pty;
mod session;

use pty::PtyManager;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

type ChildHandle = Arc<Mutex<Option<Child>>>;

struct PipelineChild(ChildHandle);
struct InstallChild(ChildHandle);
struct LocalMeetingChild(ChildHandle);

/// willSleep 콜백(C 함수라 캡처 불가)이 이벤트를 emit할 수 있도록 AppHandle을 전역 보관. setup에서 1회 채움.
static SLEEP_APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

/// 네이티브 willSleep 콜백 — 녹음 중 슬립(주로 뚜껑 닫기)을 프론트에 중계해 저장 후 종료시킨다.
extern "C" fn on_native_sleep() {
    if let Ok(guard) = SLEEP_APP_HANDLE.lock() {
        if let Some(handle) = guard.as_ref() {
            let _ = handle.emit("app:sleep_detected", ());
        }
    }
}

/// 녹음 상태 + 창 닫기 시도 횟수.
/// 녹음이 진행 중이 아닐 때는 prevent_close를 호출하지 않아 빈 화면/에러 상태에서도
/// OS 기본 닫기 동작이 그대로 작동한다. 녹음이 진행 중일 때 두 번째 X 클릭은
/// 사용자의 강제 종료 의사로 보고 자동 저장을 포기하고 즉시 종료한다.
struct CloseState {
    is_recording: AtomicBool,
    close_attempts: AtomicUsize,
}

/// bash 자신 + 손자(whisper-cli, python, ffmpeg 등)까지 한 번에 종료.
/// spawn 시 process_group(0)으로 새 그룹을 만들었으므로 child.id() == pgid.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // 음수 PID를 주면 해당 pgid의 그룹 전체에 시그널 전달 (kill(2))
    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
}

/// 정리해야 할 백그라운드 child가 있는지 확인. on_window_event 분기에 사용.
fn has_active_children(app: &tauri::AppHandle) -> bool {
    if app.state::<PtyState>().is_active() {
        return true;
    }
    if app
        .state::<PipelineChild>()
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
    {
        return true;
    }
    if app
        .state::<InstallChild>()
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
    {
        return true;
    }
    if app
        .state::<LocalMeetingChild>()
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
    {
        return true;
    }
    false
}

/// 창이 닫힐 때 모든 백그라운드 자식 프로세스를 정리.
/// PTY 세션, 전사/화자분리 파이프라인, install.sh 세 가지를 전부 처리한다.
fn cleanup_all_children(app_handle: &tauri::AppHandle) {
    // PTY 세션 (Claude Code 등) — kill()이 자식 프로세스 kill + wait까지 수행
    app_handle.state::<PtyState>().kill();

    // 전사/화자분리 파이프라인
    let pipeline_child = {
        let state = app_handle.state::<PipelineChild>();
        state.0.lock().ok().and_then(|mut g| g.take())
    };
    if let Some(mut child) = pipeline_child {
        kill_process_group(child.id());
        let _ = child.wait();
    }

    // install.sh
    let install_child = {
        let state = app_handle.state::<InstallChild>();
        state.0.lock().ok().and_then(|mut g| g.take())
    };
    if let Some(mut child) = install_child {
        kill_process_group(child.id());
        let _ = child.wait();
    }

    // 로컬 LLM 회의록 작성
    let local_meeting_child = {
        let state = app_handle.state::<LocalMeetingChild>();
        state.0.lock().ok().and_then(|mut g| g.take())
    };
    if let Some(mut child) = local_meeting_child {
        kill_process_group(child.id());
        let _ = child.wait();
    }
}

type PtyState = Arc<PtyManager>;

#[tauri::command]
fn cmd_spawn_terminal(
    app: tauri::AppHandle,
    state: State<PtyState>,
    command: String,
    args: Vec<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<(), String> {
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    // 0 또는 미전달(숨김 패널 등 측정 불가)이면 보수적 기본값.
    let rows = rows.filter(|&r| r > 0).unwrap_or(24);
    let cols = cols.filter(|&c| c > 0).unwrap_or(80);
    state.spawn(app, &command, &args_ref, rows, cols)
}

#[tauri::command]
fn cmd_pty_input(state: State<PtyState>, data: String) -> Result<(), String> {
    state.write_input(&data)
}

#[tauri::command]
fn cmd_pty_resize(state: State<PtyState>, rows: u16, cols: u16) -> Result<(), String> {
    state.resize(rows, cols)
}

#[tauri::command]
fn cmd_pty_is_active(state: State<PtyState>) -> bool {
    state.is_active()
}

#[tauri::command]
fn cmd_pty_kill(state: State<PtyState>) -> Result<(), String> {
    state.kill();
    Ok(())
}

/// 사용자가 창 닫기를 확정했을 때 호출. 자식 프로세스 정리 후 앱 종료.
#[tauri::command]
fn cmd_force_close(app: tauri::AppHandle) {
    cleanup_all_children(&app);
    app.exit(0);
}

/// status === "recording"일 때 true, 그 외엔 false. App.tsx의 useEffect가 자동 동기화.
/// 녹음 상태 전환 시 close_attempts도 함께 reset해 이전 close 시도가 남는 것 방지.
#[tauri::command]
fn cmd_set_recording(state: State<Arc<CloseState>>, recording: bool) {
    state.is_recording.store(recording, Ordering::SeqCst);
    state.close_attempts.store(0, Ordering::SeqCst);
}

/// 사용자가 자동 저장 confirm을 취소한 경우 호출. close_attempts를 reset해
/// 다음에 X를 다시 누르면 즉시 강제 종료가 아니라 confirm이 다시 뜨도록.
#[tauri::command]
fn cmd_close_cancelled(state: State<Arc<CloseState>>) {
    state.close_attempts.store(0, Ordering::SeqCst);
}

#[tauri::command]
fn cmd_check_deps(app: tauri::AppHandle) -> session::DepsStatus {
    session::check_dependencies(&app)
}

#[tauri::command]
fn cmd_get_app_dir(app: tauri::AppHandle) -> Result<String, String> {
    session::get_app_dir(&app)
}

/// LLM 작업을 수행할 CLI 선택. 사용자 영속 선택(`active_cli`) → 없으면 기본 "claude".
/// AppShell이 매 기동 시 호출 — 선택된 CLI의 junmit 전용 환경을 여기서 보장
/// (codex는 미존재 CODEX_HOME이 spawn 하드 실패, claude는 MCP·신뢰 베이크가 spawn 전에 필요).
#[tauri::command]
fn cmd_get_active_cli(app: tauri::AppHandle) -> String {
    let cli = session::read_active_cli().unwrap_or_else(|| "claude".to_string());
    match cli.as_str() {
        "codex" => session::ensure_codex_home(&app),
        "mlx" => {} // 로컬 LLM은 CLI 설정 디렉토리 불필요 (모델 존재 확인은 cmd_check_local_model)
        // 격리 홈은 없다. 워크스페이스 신뢰만 베이크(spawn 신뢰 다이얼로그 제거).
        "antigravity" => {
            session::ensure_antigravity_trust(&app);
        }
        _ => session::ensure_claude_config_dir(&app),
    }
    cli
}

/// 사용자가 온보딩/설정에서 명시 선택한 CLI를 영속 저장.
#[tauri::command]
fn cmd_set_active_cli(app: tauri::AppHandle, cli: String) -> Result<(), String> {
    session::write_active_cli(&cli)?;
    match cli.as_str() {
        "codex" => session::ensure_codex_home(&app),
        "mlx" => {} // 로컬 LLM은 CLI 설정 디렉토리 불필요
        "antigravity" => {
            session::ensure_antigravity_trust(&app);
        }
        _ => session::ensure_claude_config_dir(&app),
    }
    Ok(())
}

/// 로컬 LLM(MLX) 모델이 설치되어 있는지 — mlx 선택 시 셋업/다운로드 게이팅용.
/// "설치됨" 판정은 현재 선택된 변형(read_local_model) 기준.
#[tauri::command]
fn cmd_check_local_model() -> bool {
    session::local_model_present()
}

/// 선택된 로컬 모델 변형 (gemma-4-12b-4bit=표준 / gemma-4-12b-qat=고품질).
#[tauri::command]
fn cmd_get_local_model() -> String {
    session::read_local_model()
}

/// 로컬 모델 변형 선택 저장 — install.sh(다운로드)·local_meeting.py(실행)가 이 값을 읽는다.
#[tauri::command]
fn cmd_set_local_model(model: String) -> Result<(), String> {
    session::write_local_model(&model)
}

/// 모델 다운로드 화면에서 시작 없이 "뒤로" 시 — 미설치 변형 선택을 설치된 변형으로 복원.
#[tauri::command]
fn cmd_revert_local_model_if_missing() {
    session::revert_local_model_if_missing()
}

/// 설치된 로컬 모델 변형 목록 (완전 설치 판정 기준 — 부분 다운로드 제외).
#[tauri::command]
fn cmd_list_local_models() -> Vec<String> {
    [session::LOCAL_MODEL_STANDARD, session::LOCAL_MODEL_HIGH]
        .iter()
        .filter(|m| session::local_model_present_named(m))
        .map(|m| m.to_string())
        .collect()
}

/// 미사용 로컬 모델 변형 삭제 — 디스크 확보(6.8~11GB). mlx가 활성 CLI일 때만 현재 선택
/// 변형을 거부(회의록 작성이 깨짐) — claude/codex 사용 중엔 로컬 모델이 전혀 안 쓰이므로
/// 어느 변형이든 삭제 가능. 삭제로 선택이 미설치를 가리키게 되면 설치된 다른 변형으로
/// 복원해 유령 상태를 막는다. 부분 다운로드 잔재(중단된 변형 전환)도 같은 경로라 함께 정리.
#[tauri::command]
fn cmd_delete_local_model(model: String) -> Result<(), String> {
    if model != session::LOCAL_MODEL_STANDARD && model != session::LOCAL_MODEL_HIGH {
        return Err(format!("알 수 없는 로컬 모델: {model}"));
    }
    if model == session::read_local_model()
        && session::read_active_cli().as_deref() == Some("mlx")
    {
        return Err("사용 중인 모델은 삭제할 수 없습니다".into());
    }
    let dir = session::local_model_dir().join(&model);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("삭제 실패: {e}"))?;
    }
    session::revert_local_model_if_missing();
    Ok(())
}

/// 로컬 LLM 실행 여력(RAM·디스크 여유) — mlx 선택 시 다운로드 전 사양 경고용.
/// 값이 0이면 조회 실패(알 수 없음)이므로 UI는 경고만 하고 차단하지 않는다.
#[derive(serde::Serialize)]
struct LocalCapability {
    ram_gb: u64,
    disk_free_gb: u64,
}

#[tauri::command]
fn cmd_check_local_capable() -> LocalCapability {
    let ram_gb = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|b| b / 1024 / 1024 / 1024)
        .unwrap_or(0);
    // df -k HOME → Available(4번째 컬럼, KB). 공백 없는 안정 경로($HOME)로 조회.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let disk_free_gb = std::process::Command::new("df")
        .arg("-k")
        .arg(&home)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().nth(1).map(str::to_string))
        .and_then(|line| {
            line.split_whitespace()
                .nth(3)
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024 / 1024)
        .unwrap_or(0);
    LocalCapability { ram_gb, disk_free_gb }
}

/// 사용자가 CLI를 명시 선택한 적이 있는지 — 온보딩 첫 진입에서 선택 화면 게이팅용.
/// (cmd_get_active_cli는 미선택도 기본 "claude"를 주므로 "선택했는지" 구분엔 못 씀)
#[tauri::command]
fn cmd_is_cli_chosen() -> bool {
    session::read_active_cli().is_some()
}

/// claude/codex/antigravity 설치·인증 감지 — 온보딩 "AI 도구 선택" 화면용.
/// 외부 프로세스 최대 5개(which×2 + 인증 판정 3건 — 판정은 detect_clis 내부에서 병렬,
/// agy는 네트워크 왕복 최대 10초)라 async + blocking pool — 동기 커맨드는 메인 스레드
/// (창 이벤트 루프)를 막는다.
#[tauri::command]
async fn cmd_detect_clis(app: tauri::AppHandle) -> Result<session::CliAvailability, String> {
    tauri::async_runtime::spawn_blocking(move || session::detect_clis(&app))
        .await
        .map_err(|e| format!("CLI 감지 작업 실패: {e}"))
}

/// 현재 앱 인스턴스의 신호 디렉토리 — frontend가 PTY spawn 시 APP_SIGNAL_DIR env로 전달.
/// 인스턴스별 PID 분리로 dev+prod 동시 실행 시 신호 빼앗김 방지.
#[tauri::command]
fn cmd_get_signal_dir() -> String {
    session::app_data_dir()
        .join("run")
        .join(std::process::id().to_string())
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
fn cmd_fetch_calendar(app: tauri::AppHandle) -> Result<Vec<session::CalendarEvent>, String> {
    session::fetch_calendar_events(&app)
}

/// 참석자 이메일 → 이름 매핑 캐시 조회. 캘린더 참석자 이름 해결의 최우선 소스.
#[tauri::command]
fn cmd_read_attendee_names() -> std::collections::HashMap<String, String> {
    session::read_attendee_names()
}

/// 참석자 이름 매핑 캐시 저장 (인라인 편집 시 upsert된 전체 맵).
#[tauri::command]
fn cmd_write_attendee_names(names: std::collections::HashMap<String, String>) -> Result<(), String> {
    session::write_attendee_names(&names)
}

/// 용어 사전 조회. 전사 priming + 후보정 교정에 쓰이는 사용자 편집 사전.
#[tauri::command]
fn cmd_read_vocabulary() -> session::Vocabulary {
    session::read_vocabulary()
}

/// 용어 사전 저장 (앱 편집 화면에서 전체 목록 upsert).
#[tauri::command]
fn cmd_write_vocabulary(vocab: session::Vocabulary) -> Result<(), String> {
    session::write_vocabulary(&vocab)
}

#[tauri::command]
fn cmd_check_mic_permission() -> &'static str {
    session::mic_permission_status()
}

/// 회의 선택 화면이 not_determined일 때 호출 — OS 마이크 권한 프롬프트를 띄우고 응답까지 대기 후 상태 반환.
/// 네이티브 마이크 전환 전엔 브라우저 getUserMedia가 이 역할을 했다.
#[tauri::command]
async fn cmd_request_mic_permission() -> &'static str {
    session::request_mic_permission()
}

#[tauri::command]
fn cmd_check_calendar_permission() -> &'static str {
    session::calendar_permission_status()
}

#[tauri::command]
fn cmd_create_session(
    title: String,
    attendees: Vec<String>,
    meeting_type: Option<String>,
    time: Option<String>,
    agenda: Option<String>,
    source: Option<String>,
    detailed_correction: Option<bool>,
) -> Result<String, String> {
    let meta = session::MeetingMeta {
        title,
        date: String::new(),
        time,
        r#type: meeting_type.filter(|s| !s.is_empty()).unwrap_or_else(|| "auto".to_string()),
        attendees,
        agenda: agenda.unwrap_or_default(),
        source: source.unwrap_or_else(|| "manual".to_string()),
        detailed_correction: detailed_correction.unwrap_or(true),
        // 시스템 오디오는 항상 캡처를 시도하므로 의도를 따로 받지 않는다. 실제 캡처 결과(mic/mic+system)는
        // convert_recording이 meeting.json에 기록한다.
        capture_mode: None,
    };
    session::create_session(&meta)
}

#[tauri::command]
fn cmd_check_system_audio_permission() -> &'static str {
    session::system_audio_permission_status()
}

/// 회의 선택 화면 선제 요청·권한 카드의 "요청" — OS 권한 프롬프트를 띄우고 응답까지 대기 후 상태 반환.
#[tauri::command]
async fn cmd_request_system_audio_permission() -> &'static str {
    session::request_system_audio_permission()
}

// async — CoreAudio tap 셋업(coreaudiod XPC)·ExtAudioFile flush는 블로킹성이라 sync면 메인 UI 스레드가
// 멈춘다(cmd_save_recording과 동일 사유). 별도 worker 스레드에서 실행.

/// 녹음 시작과 함께 시스템 오디오 캡처 시작. 반환: 네이티브 CaptureResult(0=ok, 음수=거부/실패/미지원).
#[tauri::command]
async fn cmd_start_system_audio_capture() -> i32 {
    session::start_system_audio_capture()
}

/// 녹음 종료와 함께 시스템 오디오 캡처 정지.
#[tauri::command]
async fn cmd_stop_system_audio_capture() {
    let _ = session::stop_system_audio_capture();
}

/// 녹음 중 폴링 — 직전 버퍼 RMS(실시간 레벨 미터). 단순 원자 읽기라 sync(빠름, 비블로킹).
#[tauri::command]
fn cmd_system_audio_level() -> f32 {
    session::system_audio_level()
}

// 마이크 캡처 — AVAudioEngine (네이티브). async 사유는 시스템 오디오와 동일(AVAudioEngine start/stop은
// CoreAudio HAL 협상이라 블로킹성).

/// 녹음 시작 — 마이크 캡처 시작. 반환: 네이티브 CaptureResult(0=ok, 음수=실패/미지원).
#[tauri::command]
async fn cmd_start_mic_capture() -> i32 {
    session::start_mic_capture()
}

/// 녹음 종료 — 마이크 캡처 정지.
#[tauri::command]
async fn cmd_stop_mic_capture() {
    let _ = session::stop_mic_capture();
}

/// 녹음 중 폴링 — 직전 버퍼 RMS(실시간 레벨 미터). 단순 원자 읽기라 sync(빠름, 비블로킹).
#[tauri::command]
fn cmd_mic_level() -> f32 {
    session::mic_level()
}

/// 정밀 교정 토글의 sticky 기본값 조회 — MeetingSelector 마운트 시 초기 토글 상태 결정.
#[tauri::command]
fn cmd_get_detailed_default() -> bool {
    session::read_detailed_default()
}

/// 정밀 교정 토글 변경 시 sticky 기본값 저장 — 다음 회의에 동일 기본값 적용.
#[tauri::command]
fn cmd_set_detailed_default(on: bool) -> Result<(), String> {
    session::write_detailed_default(on)
}

#[tauri::command]
fn cmd_list_meeting_types() -> Result<Vec<session::MeetingTypeOption>, String> {
    session::list_meeting_types()
}

#[tauri::command]
fn cmd_read_meeting_type(name: String) -> Result<Option<String>, String> {
    session::read_meeting_type(&name)
}

#[tauri::command]
fn cmd_delete_meeting_type(name: String) -> Result<(), String> {
    session::delete_meeting_type(&name)
}

/// 담당자가 카드에서 직접 편집한 가이드 원문 저장 (게이트 검증 포함, AI·staging 경유 안 함).
#[tauri::command]
fn cmd_save_meeting_type(target: String, content: String) -> Result<(), String> {
    session::save_meeting_type(&target, &content)
}

/// 생성/조정 요청(폼·지시)을 staging의 request.json으로 기록. `/template` 스킬이 읽는다.
/// 입력을 env가 아닌 파일로 전달해 셸 이스케이프 문제를 회피한다.
#[tauri::command]
fn cmd_write_template_request(request_json: String) -> Result<(), String> {
    session::write_template_request(&request_json)
}

#[tauri::command]
fn cmd_read_staged_meeting_type() -> Result<Option<String>, String> {
    session::read_staged_meeting_type()
}

/// staging 생성물을 게이트 검증 후 live로 확정. overwrite=false(create)는 동명 거부, true(adjust)는 덮어씀.
#[tauri::command]
fn cmd_commit_meeting_type(overwrite: bool) -> Result<String, String> {
    session::commit_meeting_type(overwrite)
}

#[tauri::command]
fn cmd_clear_staged_meeting_type() -> Result<(), String> {
    session::clear_staged_meeting_type()
}

// ffmpeg 변환은 30분 회의 기준 수십 초 걸리므로(시스템 오디오 믹스 경로는 per-source loudnorm 2패스
// 측정이 더해져 ~1분) 반드시 async — sync면 메인 스레드 freeze 발생. 프론트는 saving 상태로 가림.
// 마이크·시스템 오디오 모두 녹음 중 app_data_dir 스테이징에 네이티브가 직접 기록하므로 경로 인자가 없다.
#[tauri::command]
async fn cmd_save_recording(app: tauri::AppHandle, session_dir: String) -> Result<(), String> {
    session::convert_recording(&app, &session_dir)
}

#[tauri::command]
fn cmd_find_sessions() -> Result<Vec<session::ResumableSession>, String> {
    session::find_resumable_sessions()
}

#[tauri::command]
fn cmd_delete_session(session_path: String) -> Result<(), String> {
    session::delete_session(&session_path)
}

/// dev 전용: 녹음 끝난 시점으로 세션 초기화 (처리 산출물 삭제). UI 노출은 프론트가
/// import.meta.env.DEV로 게이팅하므로 release 사용자에겐 호출 경로가 없다.
#[tauri::command]
fn cmd_reset_session_to_recording(session_path: String) -> Result<(), String> {
    session::reset_session_to_recording(&session_path)
}

/// dev 전용: 화자분리까지 완료된 시점으로 세션 초기화 (/meeting 산출물만 삭제, 전사·화자분리 보존).
/// UI 노출은 프론트가 import.meta.env.DEV로 게이팅하므로 release 사용자에겐 호출 경로가 없다.
#[tauri::command]
fn cmd_reset_session_to_diarized(session_path: String) -> Result<(), String> {
    session::reset_session_to_diarized(&session_path)
}

/// macOS `open`으로 경로(파일/디렉터리)를 시스템 기본 앱/Finder로 연다
#[tauri::command]
fn cmd_open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("열기 실패: {e}"))
}

/// filename이 세션 디렉토리 안에 있는지 검증 (path traversal 방지)
fn validate_session_filename(filename: &str) -> Result<(), String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!("잘못된 파일명: {filename}"));
    }
    Ok(())
}

#[tauri::command]
fn cmd_write_session_file(session_path: String, filename: String, content: String) -> Result<(), String> {
    validate_session_filename(&filename)?;
    let path = std::path::PathBuf::from(&session_path).join(&filename);
    std::fs::write(&path, &content)
        .map_err(|e| format!("파일 쓰기 실패: {e}"))
}

#[tauri::command]
fn cmd_read_session_file(session_path: String, filename: String) -> Result<Option<String>, String> {
    validate_session_filename(&filename)?;
    let path = std::path::PathBuf::from(&session_path).join(&filename);
    if path.exists() {
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("파일 읽기 실패: {e}"))
    } else {
        Ok(None)
    }
}

/// 회의록을 타임스탬프 백업으로 이름 바꾸고 원본 자리를 비운다 (유형 변경 후 재작성용).
/// 반환값: 백업된 파일 경로 (원본이 없으면 null).
#[tauri::command]
fn cmd_backup_meeting_notes(session_path: String) -> Result<Option<String>, String> {
    session::backup_meeting_notes(&session_path)
}

#[tauri::command]
fn cmd_cancel_pipeline(state: State<PipelineChild>) -> Result<(), String> {
    // run_pipeline의 wait()과 경합하지 않도록 child를 먼저 꺼낸다.
    let child_opt = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?.take();
    if let Some(mut child) = child_opt {
        kill_process_group(child.id());
        let _ = child.wait(); // 좀비 수거
    }
    Ok(())
}

/// ANSI escape 시퀀스 제거 (CSI: ESC '[' ... final byte in 0x40..=0x7E)
/// 파이프라인 로그를 파일에 깔끔하게 저장하기 위함. UI 이벤트 스트림엔 원본 유지.
/// char 단위 iteration — 한글 등 멀티바이트 UTF-8 보존.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // '[' 소비
            while let Some(nc) = chars.next() {
                let code = nc as u32;
                if (0x40..=0x7e).contains(&code) { break; }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 셸 명령을 자식 프로세스로 실행하고 stdout/stderr를 이벤트로 스트리밍
/// PTY가 아닌 일반 프로세스 — 전사/화자분리용
#[tauri::command]
async fn cmd_run_pipeline(
    app: tauri::AppHandle,
    state: State<'_, PipelineChild>,
    session_dir: String,
    step: String, // "transcribe" | "diarize"
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    let app_dir = session::resource_dir(&app)?.to_string_lossy().into_owned();

    // 세션 디렉토리에 pipeline.log append. 실패해도 파이프라인은 계속 (로그는 best-effort)
    let log_path = PathBuf::from(&session_dir).join("pipeline.log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));

    if let Some(f) = &log_file {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let mut w = f.lock().unwrap();
        let _ = writeln!(w, "\n=== {step} @ {ts} ===");
        let _ = writeln!(w, "env: SCRIPT_DIR={app_dir}");
        let _ = writeln!(w, "env: SESSION_DIR={session_dir}");
    }

    let script = match step.as_str() {
        "transcribe" => r#"export SCRIPT_DIR="$APP_DIR" && cd "$SCRIPT_DIR" && \
               info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }; \
               ok() { printf "\033[1;32m[완료]\033[0m %s\n" "$1"; }; \
               warn() { printf "\033[1;33m[경고]\033[0m %s\n" "$1"; }; \
               err() { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }; \
               source lib/transcribe.sh && \
               do_transcribe "$SESSION_DIR""#,
        "diarize" => r#"export SCRIPT_DIR="$APP_DIR" && cd "$SCRIPT_DIR" && \
               info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }; \
               ok() { printf "\033[1;32m[완료]\033[0m %s\n" "$1"; }; \
               warn() { printf "\033[1;33m[경고]\033[0m %s\n" "$1"; }; \
               err() { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }; \
               source lib/diarize.sh && \
               do_diarize "$SESSION_DIR""#,
        _ => return Err(format!("알 수 없는 단계: {step}")),
    };

    let app_data_dir = session::app_data_dir();
    let models_dir = session::models_dir();
    let venv_dir = session::venv_dir();

    // whisper prompt priming + 화자분리 max_speakers를 Rust에서 직접 계산해 env로 전달.
    // (셸에서 JSON을 파싱하려고 시스템 파이썬 `/usr/bin/python3`에 의존하던 걸 제거 —
    //  ML은 uv venv를 쓰지만 자잘한 파싱까지 시스템 파이썬에 기대면 CLT 미설치 사용자에게 깨짐.)
    let attendees = session::read_meeting_attendees(std::path::Path::new(&session_dir));
    let mut prompt_parts = session::read_vocabulary().terms;
    prompt_parts.extend(attendees.iter().cloned());
    let whisper_prompt = prompt_parts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let max_speakers = attendees.len();

    let mut cmd = Command::new("bash");
    cmd.args(["-c", script])
        .env("APP_DIR", &app_dir)
        .env("SESSION_DIR", &session_dir)
        .env("APP_DATA_DIR", app_data_dir)
        .env("MODELS_DIR", models_dir)
        .env("VENV_DIR", venv_dir)
        .env("WHISPER_PROMPT", &whisper_prompt)
        .env("MAX_SPEAKERS", max_speakers.to_string())
        .env("PATH", session::get_user_shell_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0); // 새 프로세스 그룹 생성: 취소 시 손자까지 묶어서 종료
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{step} 실행 실패: {e}"))?;


    // stdout/stderr 스트리밍 (\r도 줄 경계로 처리)
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Child를 state에 저장 (취소용)
    *state.0.lock().map_err(|e| format!("lock 실패: {e}"))? = Some(child);

    let app2 = app.clone();
    let step2 = step.clone();

    fn stream_pipeline(
        reader: impl std::io::Read,
        app: &tauri::AppHandle,
        step: &str,
        stream_name: &str,
        log_file: Option<Arc<Mutex<std::fs::File>>>,
    ) {
        use std::io::Write;
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut line_buf: Vec<u8> = Vec::new();
        let flush_line = |line_buf: &mut Vec<u8>| {
            if line_buf.is_empty() { return; }
            let s = String::from_utf8_lossy(line_buf).to_string();
            let _ = app.emit("pipeline:output", serde_json::json!({
                "step": step, "stream": "stdout", "line": s.clone(),
            }).to_string());
            if let Some(f) = &log_file {
                if let Ok(mut f) = f.lock() {
                    let prefix = if stream_name == "stderr" { "[stderr] " } else { "" };
                    let _ = writeln!(f, "{prefix}{}", strip_ansi(&s));
                }
            }
            line_buf.clear();
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { flush_line(&mut line_buf); break; }
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' || b == b'\r' {
                            flush_line(&mut line_buf);
                        } else {
                            line_buf.push(b);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }

    let log_for_stdout = log_file.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            stream_pipeline(out, &app2, &step2, "stdout", log_for_stdout);
        }
    });

    let app3 = app.clone();
    let step3 = step.clone();
    let log_for_stderr = log_file.clone();
    let stderr_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            stream_pipeline(err, &app3, &step3, "stderr", log_for_stderr);
        }
    });

    stdout_thread.join().ok();
    stderr_thread.join().ok();

    // state에서 child를 꺼내서 wait
    let status = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?
        .as_mut()
        .ok_or_else(|| format!("{step} child가 없습니다 (취소됨?)"))?
        .wait()
        .map_err(|e| format!("{step} 대기 실패: {e}"))?;
    *state.0.lock().map_err(|e| format!("lock 실패: {e}"))? = None;

    if let Some(f) = &log_file {
        let _ = writeln!(
            f.lock().unwrap(),
            "=== {step} exit: {} ===",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        );
    }

    if status.success() {
        // 화자분리는 오디오를 쓰는 마지막 단계 — 끝나면 회의 원본 오디오를 정리한다
        // (기본 삭제=프라이버시, keep_recording 센티넬 시 보존). /meeting·발행은 텍스트만 쓴다.
        if step == "diarize" {
            session::cleanup_recording_audio(&session_dir);
        }
        Ok(())
    } else {
        Err(format!("{step} 실패 (exit code: {:?})", status.code()))
    }
}

/// 로컬 LLM 회의록 작성 중단
#[tauri::command]
fn cmd_cancel_local_meeting(state: State<LocalMeetingChild>) -> Result<(), String> {
    let child_opt = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?.take();
    if let Some(mut child) = child_opt {
        kill_process_group(child.id());
        let _ = child.wait();
    }
    Ok(())
}

/// 로컬 LLM 회의록 작성 — venv python으로 local_meeting.py를 실행하고 stdout을 스트리밍.
/// PTY가 아닌 일반 프로세스 (전사·화자분리와 같은 결) — 로컬 파이프라인은 결정론적 1회성이라
/// 터미널 상호작용이 무의미하다. 진행 라인은 "local:output" 이벤트로, 완료/실패는 스크립트가
/// 신호 파일(APP_SIGNAL_DIR → app:signal)로 직접 emit하므로 프론트 전환 로직은 기존 경로 그대로.
#[tauri::command]
async fn cmd_run_local_meeting(
    app: tauri::AppHandle,
    state: State<'_, LocalMeetingChild>,
    session_dir: String,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    // 이중 실행 선제 거절 — 로그 헤더를 쓰기 전에 거른다(고아 헤더 방지).
    // 최종 판정은 아래 spawn 직전의 lock 구간이 담당(여기서 통과해도 거기서 재검사).
    if state.0.lock().map_err(|e| format!("lock 실패: {e}"))?.is_some() {
        return Err("로컬 회의록 작성이 이미 진행 중입니다".into());
    }

    let app_dir = session::resource_dir(&app)?.to_string_lossy().into_owned();
    let python = session::venv_dir().join("bin/python3");
    let script = PathBuf::from(&app_dir).join("lib/local_meeting.py");
    let signal_dir = session::app_data_dir()
        .join("run")
        .join(std::process::id().to_string());
    let _ = std::fs::create_dir_all(&signal_dir);

    // 세션 pipeline.log에 append — 전사·화자분리와 같은 진단 저장소를 공유.
    let log_path = PathBuf::from(&session_dir).join("pipeline.log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));
    if let Some(f) = &log_file {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let mut w = f.lock().unwrap();
        let _ = writeln!(w, "\n=== local-meeting @ {ts} ===");
        let _ = writeln!(w, "env: MODEL={}", session::read_local_model());
    }

    let mut cmd = Command::new(&python);
    // env는 스크립트가 실제로 읽는 것만 — 세션 위치·신호 디렉토리. (스크립트는 서브프로세스를
    // 띄우지 않고 경로는 __file__·app_data_dir 기준이라 APP_DIR·PATH 주입이 불필요)
    cmd.arg(&script)
        .env("APP_SESSION_DIR", &session_dir)
        .env("APP_SIGNAL_DIR", &signal_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0); // 취소 시 그룹째 종료
    // 이중 실행 가드 + spawn + 등록을 한 lock 구간에서 — 두 호출이 동시에 spawn해
    // 서로의 child를 덮어쓰는(프로세스 누수 + wait 오귀속) 경합을 원천 차단.
    let (stdout, stderr) = {
        let mut guard = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?;
        if guard.is_some() {
            return Err("로컬 회의록 작성이 이미 진행 중입니다".into());
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("로컬 회의록 실행 실패: {e}"))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *guard = Some(child);
        (stdout, stderr)
    };

    // 줄 단위 스트리밍 — \r(진행 카운터)도 줄 경계로 처리해 마지막 상태가 이벤트로 나간다.
    fn stream_local(
        reader: impl std::io::Read,
        app: &tauri::AppHandle,
        stream_name: &str,
        log_file: Option<Arc<Mutex<std::fs::File>>>,
    ) {
        use std::io::Write;
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut line_buf: Vec<u8> = Vec::new();
        let flush_line = |line_buf: &mut Vec<u8>| {
            if line_buf.is_empty() {
                return;
            }
            let s = String::from_utf8_lossy(line_buf).to_string();
            let _ = app.emit(
                "local:output",
                serde_json::json!({ "stream": stream_name, "line": s.clone() }).to_string(),
            );
            if let Some(f) = &log_file {
                if let Ok(mut f) = f.lock() {
                    // 진행 카운터("작성 중… N자")는 로그 파일엔 남기지 않는다 (수백 줄 노이즈).
                    if !s.trim_start().starts_with("작성 중…") {
                        let prefix = if stream_name == "stderr" { "[stderr] " } else { "" };
                        let _ = writeln!(f, "{prefix}{}", strip_ansi(&s));
                    }
                }
            }
            line_buf.clear();
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    flush_line(&mut line_buf);
                    break;
                }
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' || b == b'\r' {
                            flush_line(&mut line_buf);
                        } else {
                            line_buf.push(b);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }

    let app2 = app.clone();
    let log_for_stdout = log_file.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            stream_local(out, &app2, "stdout", log_for_stdout);
        }
    });
    let app3 = app.clone();
    let log_for_stderr = log_file.clone();
    let stderr_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            stream_local(err, &app3, "stderr", log_for_stderr);
        }
    });
    stdout_thread.join().ok();
    stderr_thread.join().ok();

    // child를 꺼내서 lock 밖에서 wait — lock을 잡은 채 blocking하면 취소가 영구 대기할 수 있다.
    // None이면 취소(cmd_cancel_local_meeting)가 이미 take한 것 — 오류가 아닌 의도된 중단이므로
    // 조용히 성공 반환한다 (UI 상태 정리는 취소를 부른 쪽 책임). 오류 배너 오발화 방지.
    let Some(mut child) = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?.take() else {
        if let Some(f) = &log_file {
            let _ = writeln!(f.lock().unwrap(), "=== local-meeting cancelled ===");
        }
        return Ok(());
    };
    let status = child
        .wait()
        .map_err(|e| format!("로컬 회의록 대기 실패: {e}"))?;

    if let Some(f) = &log_file {
        let _ = writeln!(
            f.lock().unwrap(),
            "=== local-meeting exit: {} ===",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        );
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("로컬 회의록 작성 실패 (exit code: {:?})", status.code()))
    }
}

/// install.sh 중단
#[tauri::command]
fn cmd_cancel_install(state: State<InstallChild>) -> Result<(), String> {
    let child_opt = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?.take();
    if let Some(mut child) = child_opt {
        kill_process_group(child.id());
        let _ = child.wait();
    }
    Ok(())
}

/// install.sh를 실행하고 출력을 스트리밍.
/// stdout/stderr를 frontend에 emit + ~/Library/Logs/<bundle_id>/install.log에 append.
/// 사용자가 setup 실패 시 Console.app 또는 직접 파일로 진단 가능.
#[tauri::command]
async fn cmd_run_install(
    app: tauri::AppHandle,
    state: State<'_, InstallChild>,
    mode: Option<String>,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // 이중 실행 거절 — 취소 직후 재시작 연타 등으로 두 install.sh가 동시에 돌면
    // child 덮어쓰기로 한쪽이 kill 불가 고아가 된다 (venv --clear 동시 실행 위험 포함).
    if state.0.lock().map_err(|e| format!("lock 실패: {e}"))?.is_some() {
        return Err("설치가 이미 진행 중입니다".into());
    }

    let resource = session::resource_dir(&app)?;
    let install_sh = resource.join("install.sh");
    if !install_sh.exists() {
        return Err("install.sh를 찾을 수 없습니다".into());
    }

    // 표준 macOS 로그 위치에 install.log append. 실패해도 setup은 계속 (로그는 best-effort).
    let log_dir = session::log_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("install.log"))
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));

    let app_data_dir = session::app_data_dir();
    let models_dir = session::models_dir();
    let venv_dir = session::venv_dir();

    let mut cmd = Command::new("bash");
    cmd.arg(install_sh.to_str().unwrap())
        .current_dir(&resource)
        .env("APP_DATA_DIR", &app_data_dir)
        .env("MODELS_DIR", &models_dir)
        .env("VENV_DIR", &venv_dir)
        // base(기본): 기초 설치, model: 로컬 LLM 모델만 (install.sh가 분기).
        .env("INSTALL_MODE", mode.as_deref().unwrap_or("base"))
        .env("PATH", session::get_user_shell_path());

    // log header — pipeline.log 패턴과 일관
    if let Some(f) = &log_file {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let mut w = f.lock().unwrap();
        let _ = writeln!(w, "\n=== install @ {ts} ===");
        let _ = writeln!(w, "env: RESOURCE_DIR={}", resource.display());
        let _ = writeln!(w, "env: APP_DATA_DIR={}", app_data_dir.display());
    }

    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("install.sh 실행 실패: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Child를 state에 저장 (취소용)
    *state.0.lock().map_err(|e| format!("lock 실패: {e}"))? = Some(child);

    let app2 = app.clone();

    // \n과 \r 모두 줄 경계로 처리 (UTF-8 안전 + curl progress 실시간)
    // log_file이 Some이면 파일에도 동시 기록 (ANSI 색상 제거).
    fn stream_lines(
        reader: impl Read,
        app: &tauri::AppHandle,
        log_file: Option<Arc<Mutex<std::fs::File>>>,
    ) {
        use std::io::Write;
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut line_buf: Vec<u8> = Vec::new();
        let flush_line = |line_buf: &mut Vec<u8>| {
            if line_buf.is_empty() { return; }
            let s = String::from_utf8_lossy(line_buf).to_string();
            let _ = app.emit("install:output", s.clone());
            if let Some(f) = &log_file {
                if let Ok(mut f) = f.lock() {
                    let _ = writeln!(f, "{}", strip_ansi(&s));
                }
            }
            line_buf.clear();
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { flush_line(&mut line_buf); break; }
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' || b == b'\r' {
                            flush_line(&mut line_buf);
                        } else {
                            line_buf.push(b);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }

    let log_for_stdout = log_file.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            stream_lines(out, &app2, log_for_stdout);
        }
    });

    let app3 = app.clone();
    let log_for_stderr = log_file.clone();
    let stderr_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            stream_lines(err, &app3, log_for_stderr);
        }
    });

    stdout_thread.join().ok();
    stderr_thread.join().ok();

    // state에서 child를 꺼내서 wait
    let status = state.0.lock().map_err(|e| format!("lock 실패: {e}"))?
        .as_mut()
        .ok_or("install child가 없습니다 (취소됨?)")?
        .wait()
        .map_err(|e| format!("install.sh 대기 실패: {e}"))?;
    *state.0.lock().map_err(|e| format!("lock 실패: {e}"))? = None;

    if let Some(f) = &log_file {
        let _ = writeln!(
            f.lock().unwrap(),
            "=== install exit: {} ===",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        );
    }

    if status.success() {
        Ok(())
    } else {
        Err(format!("install.sh 실패 (exit code: {:?})", status.code()))
    }
}

fn main() {
    let pty_manager = Arc::new(PtyManager::new());
    let pipeline_child = PipelineChild(Arc::new(Mutex::new(None)));
    let install_child = InstallChild(Arc::new(Mutex::new(None)));
    let local_meeting_child = LocalMeetingChild(Arc::new(Mutex::new(None)));
    let close_state = Arc::new(CloseState {
        is_recording: AtomicBool::new(false),
        close_attempts: AtomicUsize::new(0),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty_manager)
        .manage(pipeline_child)
        .manage(install_child)
        .manage(local_meeting_child)
        .manage(close_state.clone())
        .on_window_event(move |window, event| {
            // 닫기 정책 — 메인 윈도우 한정. 보조 윈도우(reminder 등)는 OS 기본 닫기.
            //   1. 녹음도 child도 없음 → OS 기본 닫기 (빈 화면/에러/select/done 등에서 안전)
            //   2. 녹음 중 첫 X → JS에 위임해 자동 저장 confirm 흐름
            //   3. child(pipeline/claude/install)만 있음 → confirm 없이 cleanup 후 종료
            //   4. 두 번째 이상 X → JS가 응답 못 하는 상황으로 보고 즉시 강제 종료
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let recording = close_state.is_recording.load(Ordering::SeqCst);
                let has_children = has_active_children(window.app_handle());

                if !recording && !has_children {
                    return;
                }

                let n = close_state.close_attempts.fetch_add(1, Ordering::SeqCst);
                if n >= 1 {
                    cleanup_all_children(window.app_handle());
                    window.app_handle().exit(0);
                    return;
                }

                if recording {
                    // OS 기본 닫기 차단하고 JS에 위임 — 자동 저장 confirm 흐름
                    api.prevent_close();
                    let _ = window.emit("app:close_requested", ());
                } else {
                    // OS 기본 닫기 차단하고 child 정리 후 직접 종료
                    api.prevent_close();
                    cleanup_all_children(window.app_handle());
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            // 자가업데이트 안전벨트 — 자기 앱 번들의 com.apple.quarantine 제거.
            // 미서명 앱이 .app을 교체·재실행해도 Gatekeeper 경고가 재발하지 않게.
            // release 빌드에서만 실효(dev는 .app 번들이 아님). best-effort.
            session::strip_own_quarantine();

            // 회의 유형 가이드 시드 — 사용자 위치에 없는 파일만 복사 (idempotent)
            if let Err(e) = session::seed_user_templates(app.handle()) {
                eprintln!("templates 시드 실패: {e}");
            }

            // 용어 사전 시드 — 사용자 위치에 없을 때만 복사 (idempotent)
            if let Err(e) = session::seed_user_vocabulary(app.handle()) {
                eprintln!("vocabulary 시드 실패: {e}");
            }

            // 슬립 감지 콜백 등록(핸들 보관 후) — 녹음 중 슬립 시 네이티브가 on_native_sleep 호출.
            if let Ok(mut guard) = SLEEP_APP_HANDLE.lock() {
                *guard = Some(app.handle().clone());
            }
            session::set_sleep_callback(on_native_sleep);

            // 신호 파일 감시 스레드 — 비-tty 실행(Claude Code Bash의 signal.sh,
            // 로컬 LLM의 local_meeting.py)이 보낸 신호를 수신.
            // 발신자가 append(`>>`)로 라인 단위 기록 → thread가 라인별로 emit.
            // atomic rename으로 처리 중 새 신호 도착 시 별도 파일로 분리 (인스턴스 내 race 회피).
            //
            // 인스턴스 간 분리 — `app_data_dir/run/{pid}/` 디렉토리 사용:
            // dev/prod 또는 두 인스턴스 동시 실행 시 같은 `/tmp/.app-signal` 공유로
            // 한 앱이 다른 앱 신호를 가로채는 race 방지. 각 인스턴스가 자기 PID 디렉토리만 감시.
            let signal_dir = session::app_data_dir()
                .join("run")
                .join(std::process::id().to_string());
            if let Err(e) = std::fs::create_dir_all(&signal_dir) {
                eprintln!("신호 디렉토리 생성 실패 ({}): {e}", signal_dir.display());
            }
            let signal_path = signal_dir.join(".app-signal");
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if !signal_path.exists() { continue; }
                    let processing_path = signal_path.with_extension("processing");
                    if std::fs::rename(&signal_path, &processing_path).is_err() { continue; }
                    if let Ok(content) = std::fs::read_to_string(&processing_path) {
                        for line in content.lines() {
                            let line = line.trim();
                            if !line.is_empty() {
                                let _ = app_handle.emit("app:signal", line.to_string());
                            }
                        }
                    }
                    let _ = std::fs::remove_file(&processing_path);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_spawn_terminal,
            cmd_pty_input,
            cmd_pty_resize,
            cmd_pty_is_active,
            cmd_pty_kill,
            cmd_force_close,
            cmd_set_recording,
            cmd_close_cancelled,
            cmd_check_deps,
            cmd_run_install,
            cmd_cancel_install,
            cmd_get_app_dir,
            cmd_get_active_cli,
            cmd_set_active_cli,
            cmd_is_cli_chosen,
            cmd_check_local_model,
            cmd_get_local_model,
            cmd_set_local_model,
            cmd_revert_local_model_if_missing,
            cmd_list_local_models,
            cmd_delete_local_model,
            cmd_check_local_capable,
            cmd_detect_clis,
            cmd_get_signal_dir,
            cmd_fetch_calendar,
            cmd_read_attendee_names,
            cmd_write_attendee_names,
            cmd_read_vocabulary,
            cmd_write_vocabulary,
            cmd_check_mic_permission,
            cmd_request_mic_permission,
            cmd_start_mic_capture,
            cmd_stop_mic_capture,
            cmd_mic_level,
            cmd_check_calendar_permission,
            cmd_check_system_audio_permission,
            cmd_request_system_audio_permission,
            cmd_start_system_audio_capture,
            cmd_stop_system_audio_capture,
            cmd_system_audio_level,
            cmd_create_session,
            cmd_get_detailed_default,
            cmd_set_detailed_default,
            cmd_list_meeting_types,
            cmd_read_meeting_type,
            cmd_delete_meeting_type,
            cmd_save_meeting_type,
            cmd_write_template_request,
            cmd_read_staged_meeting_type,
            cmd_commit_meeting_type,
            cmd_clear_staged_meeting_type,
            cmd_save_recording,
            cmd_find_sessions,
            cmd_delete_session,
            cmd_reset_session_to_recording,
            cmd_reset_session_to_diarized,
            cmd_open_path,
            cmd_run_pipeline,
            cmd_cancel_pipeline,
            cmd_run_local_meeting,
            cmd_cancel_local_meeting,
            cmd_write_session_file,
            cmd_read_session_file,
            cmd_backup_meeting_notes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
