use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send>>>,
    /// 의도적 kill(새 spawn의 기존 세션 대체, 화면 정리, CLI 전환) 표시 — reader 스레드가
    /// 이 플래그를 보고 `pty:exit` emit을 억제한다. 자발 종료(명령 완료·사용자 exit)만
    /// 종료 이벤트로 전달해야, 옛 세션의 stale exit가 새 세션의 종료로 오인되는 race가 없다
    /// (예: 발행 게이트의 로그인 도우미 spawn이 살아있는 세션 PTY를 대체하는 경우).
    killed: Arc<AtomicBool>,
}

pub struct PtyManager {
    session: Mutex<Option<PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    /// rows/cols: 프론트 xterm의 현재 크기 — 처음부터 이 크기로 PTY를 연다. 크기 동기화를
    /// ResizeObserver(컨테이너 크기 변화)에만 맡기면, 드로어가 이미 열린 채 PTY만 교체되는
    /// 경로(발행 게이트 도우미·Tier-2 재spawn)에서 리사이즈가 한 번도 안 가서 TUI가
    /// 기본 80×24 기준으로 그려져 화면이 깨진다.
    pub fn spawn(
        &self,
        app: AppHandle,
        command: &str,
        args: &[&str],
        rows: u16,
        cols: u16,
    ) -> Result<(), String> {
        // 기존 세션 종료
        self.kill();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY 열기 실패: {e}"))?;

        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(*arg);
        }

        // 환경변수 설정
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "ko_KR.UTF-8");

        // 사용자의 로그인 쉘 PATH 사용 (brew, nvm, claude 등 포함)
        cmd.env("PATH", crate::session::get_user_shell_path());

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("명령 실행 실패: {e}"))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("reader 복제 실패: {e}"))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("writer 가져오기 실패: {e}"))?;

        let killed = Arc::new(AtomicBool::new(false));
        let session = PtySession {
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            killed: killed.clone(),
        };

        *self.session.lock().unwrap() = Some(session);

        // PTY 출력을 프론트엔드로 전달하는 스레드
        // OSC 7777 시퀀스를 가로채서 app:signal 이벤트로 변환
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            let osc_start = b"\x1b]7777;";
            let osc_end = b'\x07';
            let mut pending: Vec<u8> = Vec::new(); // 버퍼 경계에 걸린 불완전 OSC
            const MAX_PENDING: usize = 64 * 1024; // 64KB 제한

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        if !killed.load(Ordering::SeqCst) {
                            let _ = app.emit("pty:exit", ());
                        }
                        break;
                    }
                    Ok(n) => {
                        // 의도적 kill 후 드레인되는 잔여 출력·신호는 버린다 — 프론트가 새 세션을
                        // 같은 xterm에 붙이며 전체 리셋한 뒤에 도착하면 새 화면을 다시 오염시키고,
                        // 죽은 세션의 OSC 신호가 뒤늦게 발화하는 것도 막는다.
                        if killed.load(Ordering::SeqCst) {
                            continue;
                        }
                        // pending 버퍼 크기 초과 시 비정상 시퀀스로 간주, 그대로 출력
                        if pending.len() > MAX_PENDING {
                            pending.clear();
                        }

                        // pending 버퍼가 있으면 합치기
                        let data = if pending.is_empty() {
                            buf[..n].to_vec()
                        } else {
                            let mut combined = std::mem::take(&mut pending);
                            combined.extend_from_slice(&buf[..n]);
                            combined
                        };

                        let processed = process_osc(&data, osc_start, osc_end, &app, &mut pending);
                        if !processed.is_empty() {
                            let encoded = STANDARD.encode(&processed);
                            let _ = app.emit("pty:data", encoded);
                        }
                    }
                    Err(_) => {
                        if !killed.load(Ordering::SeqCst) {
                            let _ = app.emit("pty:exit", ());
                        }
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    pub fn write_input(&self, data: &str) -> Result<(), String> {
        let session = self.session.lock().unwrap();
        if let Some(ref s) = *session {
            let mut writer = s.writer.lock().unwrap();
            writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("입력 전송 실패: {e}"))?;
            writer.flush().map_err(|e| format!("flush 실패: {e}"))?;
            Ok(())
        } else {
            Err("활성 세션 없음".into())
        }
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let session = self.session.lock().unwrap();
        if let Some(ref s) = *session {
            let master = s.master.lock().unwrap();
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("리사이즈 실패: {e}"))?;
            Ok(())
        } else {
            Err("활성 세션 없음".into())
        }
    }

    pub fn kill(&self) {
        let mut session = self.session.lock().unwrap();
        if let Some(ref s) = *session {
            // kill 전에 플래그 set — reader가 EOF를 보기 전에 의도적 종료임이 보이도록.
            s.killed.store(true, Ordering::SeqCst);
            // 자식 프로세스를 명시적으로 종료하고 wait
            let mut child = s.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        *session = None;
    }

    /// 활성 PTY 세션이 있는지 확인. lock poison 시 false (poison이면 cleanup이 의미 없음).
    pub fn is_active(&self) -> bool {
        self.session.lock().map(|s| s.is_some()).unwrap_or(false)
    }
}

/// OSC 7777 시퀀스를 가로채고 나머지를 반환. 복수 시퀀스 처리 + 버퍼 경계 처리.
fn process_osc(
    data: &[u8],
    osc_start: &[u8],
    osc_end: u8,
    app: &AppHandle,
    pending: &mut Vec<u8>,
) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut cursor = 0;

    while cursor < data.len() {
        if let Some(rel_pos) = find_subsequence(&data[cursor..], osc_start) {
            let abs_pos = cursor + rel_pos;
            // OSC 시작 전의 데이터를 출력에 추가
            output.extend_from_slice(&data[cursor..abs_pos]);

            let payload_start = abs_pos + osc_start.len();
            if let Some(end_rel) = data[payload_start..].iter().position(|&b| b == osc_end) {
                // 완전한 OSC: 페이로드 추출 → 이벤트 emit
                let payload = &data[payload_start..payload_start + end_rel];
                if let Ok(json_str) = std::str::from_utf8(payload) {
                    let _ = app.emit("app:signal", json_str.to_string());
                }
                cursor = payload_start + end_rel + 1; // BEL 다음으로
            } else {
                // 불완전 OSC: 나머지를 pending에 저장 (다음 read에서 합침)
                *pending = data[abs_pos..].to_vec();
                return output;
            }
        } else {
            // OSC 없음: 나머지 전부 출력
            output.extend_from_slice(&data[cursor..]);
            break;
        }
    }

    output
}

/// 바이트 슬라이스에서 서브시퀀스의 시작 위치를 찾음
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
