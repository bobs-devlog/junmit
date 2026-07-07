//! 원격 텔레메트리(Sentry 에러·크래시 수집) — 프라이버시 게이트를 통과한 진단만 전송.
//!
//! 원칙:
//! - **회의 내용 무전송**: 전사·회의록·회의 제목은 어떤 경로로도 보내지 않는다.
//!   호출부가 `scrub_diagnostics`로 스크러빙한 텍스트만 이 모듈에 넘긴다.
//! - **release + opt-in + DSN 존재 게이트**: debug 빌드거나, 사용자가 토글을 껐거나,
//!   DSN이 비어 있으면 완전 비활성(전송 안 하는 Sentry 클라이언트 → 사실상 no-op).
//! - **PII 최소화**: `send_default_pii=false`, `before_send`에서 서버 이름(기기명) 제거.
//!
//! 토글 변경은 재시작 후 반영된다 — Sentry 클라이언트가 앱 시작 시 1회 초기화되기 때문.

use sentry::IntoDsn;

/// **빌드 시 env `JUNMIT_SENTRY_DSN`으로만 주입**한다 — 공개 레포라 소스엔 두지 않는다.
/// 이유: 소스에 박으면 포크한 사람의 빌드가 우리 Sentry 프로젝트로 이벤트를 보내(할당량 소모·
/// 대시보드 오염) 버린다. CI(release.yml)는 GitHub Actions 시크릿에서, 로컬 dmg는 gitignore된
/// `.env.release`에서 주입한다. 포크는 시크릿을 상속받지 못해 빈 값 → 전송 안 함.
/// 비어 있으면 원격 전송을 하지 않는다(로컬 파일 로그만 동작).
const SENTRY_DSN: &str = match option_env!("JUNMIT_SENTRY_DSN") {
    Some(v) => v,
    None => "",
};

/// release 빌드 + 사용자 동의(telemetry_enabled) + DSN 존재일 때만 원격 전송한다.
pub fn is_enabled() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if SENTRY_DSN.is_empty() {
        return false;
    }
    crate::session::read_telemetry_enabled()
}

/// Sentry 클라이언트 옵션. 비활성 상태면 DSN을 비워(None) 전송하지 않는 클라이언트를 만든다.
pub fn client_options(release: String) -> sentry::ClientOptions {
    // 최종 사용자 홈 경로(/Users/<계정명>) — 런타임 에러 메시지·브레드크럼·스택에 우발적으로 실려
    // 나갈 수 있어 before_send에서 전역 익명화한다(계정명은 약한 식별자라 프라이버시 우선).
    let home = std::env::var("HOME").unwrap_or_default();
    let mut opts = sentry::ClientOptions {
        release: Some(release.into()),
        send_default_pii: false,
        before_send: Some(std::sync::Arc::new(
            move |mut event: sentry::protocol::Event<'static>| {
                // 서버 이름(호스트명=사용자 기기명일 수 있음) 제거 — 익명성 유지.
                event.server_name = None;
                // 홈 경로 → ~ : 이벤트를 JSON(=Sentry 전송 포맷)으로 직렬화해 모든 문자열에서 치환.
                // 라운드트립 실패 시엔 서버명만 지운 원본을 보낸다(에러 리포팅 자체는 보존).
                if !home.is_empty() {
                    if let Ok(mut json) = serde_json::to_value(&event) {
                        scrub_home_in_json(&mut json, &home);
                        if let Ok(scrubbed) = serde_json::from_value(json) {
                            event = scrubbed;
                        }
                    }
                }
                Some(event)
            },
        )),
        ..Default::default()
    };
    if is_enabled() {
        opts.dsn = SENTRY_DSN.into_dsn().ok().flatten();
    }
    opts
}

/// serde_json 값 트리의 모든 문자열에서 홈 경로를 `~`로 치환 (재귀).
fn scrub_home_in_json(v: &mut serde_json::Value, home: &str) {
    match v {
        serde_json::Value::String(s) => {
            if s.contains(home) {
                *s = s.replace(home, "~");
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                scrub_home_in_json(item, home);
            }
        }
        serde_json::Value::Object(map) => {
            for val in map.values_mut() {
                scrub_home_in_json(val, home);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_home_replaces_in_nested_strings() {
        let mut v = serde_json::json!({
            "msg": "/Users/alice/Library/app.junmit/output/123_비밀회의",
            "arr": ["/Users/alice/x", "무관한 문자열"],
            "nested": { "p": "홈 경로 없음" },
            "num": 42
        });
        scrub_home_in_json(&mut v, "/Users/alice");
        assert_eq!(v["msg"], "~/Library/app.junmit/output/123_비밀회의");
        assert_eq!(v["arr"][0], "~/x");
        assert_eq!(v["arr"][1], "무관한 문자열"); // 홈 경로 없으면 그대로
        assert_eq!(v["nested"]["p"], "홈 경로 없음");
        assert_eq!(v["num"], 42); // 비문자열은 불변
    }

    #[test]
    fn event_roundtrips_through_json() {
        // before_send가 의존하는 Event<->JSON 라운드트립이 실제로 성립하는지 검증.
        // (실패하면 하드닝이 조용히 no-op가 되므로 회귀 가드로 남긴다.)
        let event = sentry::protocol::Event::default();
        let json = serde_json::to_value(&event).expect("Event 직렬화");
        let _back: sentry::protocol::Event =
            serde_json::from_value(json).expect("Event 역직렬화 라운드트립");
    }
}

/// 파이프라인/로컬LLM 실패를 Sentry로 전송 — 이미 스크러빙된 tail만 받는다.
/// 비활성이면 아무 것도 하지 않는다. (호출부는 이미 로컬 로그에 기록함)
pub fn capture_pipeline_failure(label: &str, code: Option<i32>, scrubbed_tail: &str) {
    if !is_enabled() {
        return;
    }
    sentry::with_scope(
        |scope| {
            scope.set_tag("phase", label);
            if let Some(c) = code {
                scope.set_tag("exit_code", c);
            }
            scope.set_extra("pipeline_log_tail", scrubbed_tail.to_owned().into());
        },
        || {
            sentry::capture_message(
                &format!("파이프라인 실패: {label}"),
                sentry::Level::Error,
            );
        },
    );
}
