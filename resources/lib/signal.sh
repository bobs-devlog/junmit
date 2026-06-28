#!/usr/bin/env bash
# Junmit 앱과의 OSC 7777 통신 헬퍼
#
# 사용법:
#   source lib/signal.sh
#   app_notify "화자 매칭을 확인해주세요"
#   app_refresh
#   app_phase_step_done "correct"
#   app_phase_done

# OSC 7777 신호 전송
# - PTY 내부 (터미널): stdout으로 OSC 시퀀스 출력 → Rust PTY reader가 가로챔
# - Claude Code Bash: stdout이 캡처되므로 신호 파일에 append (Rust thread가 line-by-line 처리)
#
# append 모드 사용 이유 — 짧은 시간 안에 연속 호출(예: phase_done + notify) 시
# 덮어쓰기(`>`)면 마지막 호출만 남아 앞 신호를 잃습니다. append(`>>`)로 모두 보존.
_app_signal() {
  if [ -t 1 ]; then
    # stdout이 터미널 → OSC 시퀀스로 전송
    printf '\033]7777;%s\007' "$1"
  else
    # stdout이 터미널이 아님 → 신호 파일에 append (라인 단위)
    local signal_dir="${APP_SIGNAL_DIR:-${TMPDIR:-/tmp}}"
    echo "$1" >> "$signal_dir/.app-signal" 2>/dev/null || true
  fi
}

# 앱에 알림 전송 (macOS 알림 + 사이드바 배지)
app_notify() {
  _app_signal "{\"type\":\"notify\",\"msg\":\"$1\"}"
}

# 문서 탭 새로고침 요청
app_refresh() {
  _app_signal '{"type":"refresh"}'
}

# Phase 내 sub-step 종료 (예: phase1의 "correct" — 대화 교정 종료, 회의록 작성으로 전이)
app_phase_step_done() {
  _app_signal "{\"type\":\"phase_step_done\",\"step\":\"$1\"}"
}

# Phase 전체 종료 (phase1·phase2 공통 — 앱이 idle로 전환, PTY는 살림)
app_phase_done() {
  _app_signal '{"type":"phase_done"}'
}

# 회의 유형 가이드 생성/조정 완료 — 앱이 staging 결과를 읽어 미리보기 표시 (세션과 무관)
app_template_ready() {
  _app_signal '{"type":"template_ready"}'
}
