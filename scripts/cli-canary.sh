#!/usr/bin/env bash
# CLI 계약 카나리아 — claude·codex를 앱(cmd_run_headless_meeting)과 동일한 플래그·격리 홈·
# cwd로 1회씩 실행해, headless.ts 파서가 의존하는 최소 이벤트 계약이 유지되는지 검증한다.
#
# 왜: CLI는 사용자 기기에서 자동 업데이트되고(특히 claude는 백그라운드 무통보), 스키마가
# 바뀌어도 파서는 미지 이벤트를 조용히 무시하므로 진행 패널이 빈 채로 회의록만 생성되는
# "무음 열화"가 된다. 이 스크립트가 사용자보다 먼저 죽는 카나리아 역할.
#
# 언제: pipeline.log의 cli-version 줄이 지난 실행과 달라졌을 때 / 릴리스 전 1회.
# 비용: 구독 쿼터 소량(사소한 프롬프트 2회). 격리 홈 로그인 필요(앱에서 로그인한 상태면 됨).
#
# 검증 항목은 2026-08-01 실측(실제 headless.jsonl + headless.ts 파서)에서 도출:
#  claude: system/init(session_id) · init.slash_commands에 meeting(스킬 로드 = --bare 전환 감시)
#          · assistant(message.content[].text) · result(is_error 필드)
#  codex:  thread.started(thread_id) · item.completed(item.type=agent_message, item.text)
#          · turn.completed  + 앱과 동일 플래그 수용 여부
#  (sub-agent 이벤트(claude task_*, codex collab_tool_call)는 사소 프롬프트에선 발생하지
#   않아 라이브 검증 불가 — 실제 /meeting 실행 후 headless.jsonl로만 확인 가능.)

set -u

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
pass() { printf "\033[1;32m[PASS]\033[0m %s\n" "$1"; }
fail() { printf "\033[1;31m[FAIL]\033[0m %s\n" "$1"; }
skip() { printf "\033[1;33m[SKIP]\033[0m %s\n" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../resources"
APP_DATA="$HOME/Library/Application Support/app.junmit"
OUT_DIR="$(mktemp -d)"
FAILURES=0
# 성공 시에만 정리 — 실패 시 스트림 원문을 보존해 진단 재료로 남긴다.
cleanup() { [[ "${FAILURES:-0}" -eq 0 ]] && rm -rf "$OUT_DIR"; }
trap cleanup EXIT

# 배경 실행 + 시한 초과 시 강제 종료. macOS엔 timeout(1)이 기본 부재라 자체 구현.
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$rc"
}

# ---------- claude ----------
check_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    skip "claude 미설치"
    return
  fi
  info "claude $(claude --version 2>/dev/null | head -1)"
  if [[ ! -d "$APP_DATA/claude" ]]; then
    skip "claude 격리 홈 없음($APP_DATA/claude) — 앱에서 Claude Code 로그인 후 사용"
    return
  fi

  local out="$OUT_DIR/claude.jsonl" errf="$OUT_DIR/claude.err"
  # 앱과 동일: 격리 홈 + cwd=resources(스킬 로드 검증에 필수) + 동일 플래그. 프롬프트만 사소.
  if ! (cd "$RESOURCES_DIR" && CLAUDE_CONFIG_DIR="$APP_DATA/claude" \
      run_with_timeout 120 claude -p "카나리아 점검입니다. OK라고만 답하세요." \
        --output-format stream-json --verbose --permission-mode bypassPermissions \
        > "$out" 2> "$errf"); then
    fail "claude 실행 실패 (로그인 만료·플래그 거부 가능. stderr: $(head -c 300 "$errf"))"
    FAILURES=$((FAILURES + 1))
    return
  fi

  if python3 - "$out" <<'PY'; then
import json, sys
init = result = assistant = skill = False
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "system" and d.get("subtype") == "init" and d.get("session_id"):
        init = True
        skill = "meeting" in (d.get("slash_commands") or [])
    if d.get("type") == "result" and "is_error" in d:
        result = True
    if d.get("type") == "assistant":
        blocks = (d.get("message") or {}).get("content")
        if isinstance(blocks, list) and any(b.get("type") == "text" for b in blocks if isinstance(b, dict)):
            assistant = True
checks = {"system/init(session_id)": init, "init에 meeting 스킬(--bare 감시)": skill,
          "assistant 텍스트": assistant, "result(is_error)": result}
for name, ok in checks.items():
    print(("  ✓ " if ok else "  ✗ ") + name)
sys.exit(0 if all(checks.values()) else 1)
PY
    pass "claude 계약 유지"
  else
    fail "claude 계약 위반 — 위 ✗ 항목. 파서 수정 지점: src/utils/headless.ts parseClaudeEvent"
    FAILURES=$((FAILURES + 1))
  fi
}

# ---------- codex ----------
check_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    skip "codex 미설치"
    return
  fi
  info "codex $(codex --version 2>/dev/null | head -1)"
  if [[ ! -d "$APP_DATA/codex" ]]; then
    skip "codex 격리 홈 없음($APP_DATA/codex) — 앱에서 Codex 로그인 후 사용"
    return
  fi

  local out="$OUT_DIR/codex.jsonl" errf="$OUT_DIR/codex.err"
  if ! (cd "$RESOURCES_DIR" && CODEX_HOME="$APP_DATA/codex" \
      run_with_timeout 120 codex exec --json --skip-git-repo-check \
        --sandbox workspace-write --add-dir "$APP_DATA" \
        "카나리아 점검입니다. OK라고만 답하세요." \
        > "$out" 2> "$errf"); then
    fail "codex 실행 실패 (로그인 만료·플래그 거부 가능. stderr: $(head -c 300 "$errf"))"
    FAILURES=$((FAILURES + 1))
    return
  fi

  if python3 - "$out" <<'PY'; then
import json, sys
started = message = completed = False
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "thread.started" and d.get("thread_id"):
        started = True
    if d.get("type") == "item.completed":
        item = d.get("item") or {}
        if item.get("type") == "agent_message" and item.get("text"):
            message = True
    if d.get("type") == "turn.completed":
        completed = True
checks = {"thread.started(thread_id)": started,
          "item.completed(agent_message.text)": message, "turn.completed": completed}
for name, ok in checks.items():
    print(("  ✓ " if ok else "  ✗ ") + name)
sys.exit(0 if all(checks.values()) else 1)
PY
    pass "codex 계약 유지"
  else
    fail "codex 계약 위반 — 위 ✗ 항목. 파서 수정 지점: src/utils/headless.ts parseCodexEvent"
    FAILURES=$((FAILURES + 1))
  fi
}

check_claude
check_codex

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  pass "카나리아 통과 — 현재 설치된 CLI 버전과 파서 계약이 일치합니다"
else
  fail "카나리아 실패 ${FAILURES}건 — 스트림 원문 보존됨: $OUT_DIR"
  exit 1
fi
