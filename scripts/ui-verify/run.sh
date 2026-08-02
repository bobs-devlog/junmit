#!/usr/bin/env bash
# UI 작업용 검증 도구 — vite dev + Tauri IPC shim(invoke 모킹)으로 앱 화면을 헤드리스 브라우저에서
# 조작해 프론트 동작을 확인한다. dev 빌드는 캘린더 권한이 늘 거부라 홈 진입 상태 재현이 어렵고,
# 릴리스 앱은 클릭 검증이 수동이 되므로, 부트 게이트를 shim으로 통과시켜 원하는 상태를 만든다.
#
# ⚠️ 이건 **회귀 스위트가 아니다.** CI에서 돌지 않고(브라우저 다운로드·릴리스 빌드 오염 회피)
# 자동 실행 지점도 없다. UI를 고칠 때 사람/AI가 그 자리에서 돌려 쓰는 도구이며, 방치돼 깨져
# 있어도 무해하다(쓸 때 고친다). 존재 이유는 커버리지가 아니라 **재구성 비용 절약** —
# shim 골격·부트 게이트 커맨드 목록·CSS 모듈 셀렉터 규칙 같은 시행착오가 코드로 남아 있어,
# 다음 UI 작업에서 검증을 처음부터 만들지 않아도 된다.
#
# 검증하는 것: 화면 렌더·상태 전이·invoke 호출 인자(무엇을 백엔드에 넘겼는가).
# 검증 못 하는 것: 네이티브 플러그인 실배선(저장 패널이 실제로 뜨는가), 권한 프롬프트,
#   WKWebView 렌더 차이. Rust 로직은 cargo test, 네이티브는 사람 눈 — 3층 분업의 가운데 층.
#
# 사용: bash scripts/ui-verify/run.sh [verify-search|verify-export]  (인자 없으면 전부)
#
# playwright는 repo 의존성에 넣지 않는다 — 릴리스 CI(npm ci)가 브라우저까지 받게 되는 걸 피하려고
# 이 디렉토리에 자체 설치한다(gitignored). 최초 1회만 수 분, 이후 재사용.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT=1420

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
err() { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }

# 1) 하네스 전용 의존성 보장
# 자체 package.json이 **먼저** 있어야 한다 — 없으면 npm이 상위로 올라가 루트 package.json에
# playwright를 dependencies로 박는다(실측: 릴리스 번들 오염). 이 파일은 gitignored.
if [[ ! -f "$HERE/package.json" ]]; then
  printf '{\n  "name": "junmit-ui-verify",\n  "private": true,\n  "type": "module"\n}\n' \
    > "$HERE/package.json"
fi
if [[ ! -d "$HERE/node_modules/playwright" ]]; then
  info "playwright 설치 (최초 1회)"
  (cd "$HERE" && npm install --silent --no-fund --no-audit playwright) || {
    err "playwright 설치 실패"
    exit 1
  }
fi
if ! (cd "$HERE" && npx playwright install chromium --only-shell >/dev/null 2>&1); then
  info "chromium 준비 실패 — 이미 설치돼 있으면 무시됩니다"
fi

# 2) vite dev 기동 (이미 떠 있으면 재사용하고 종료도 안 건드린다)
started_vite=0
if curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null; then
  info "기존 vite($PORT) 재사용"
else
  info "vite dev 기동"
  (cd "$ROOT" && npx vite --port "$PORT" --strictPort >"$HERE/vite.log" 2>&1 &)
  started_vite=1
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null && break
    sleep 0.5
  done
  if ! curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null; then
    err "vite 기동 실패 — $HERE/vite.log 확인"
    exit 1
  fi
fi

cleanup() {
  # 이 스크립트가 띄운 경우에만 정리. 종료 신호로 셸이 찍는 "Terminated" 잡 메시지는 억제한다.
  [[ "$started_vite" -eq 1 ]] || return 0
  exec 3>&2 2>/dev/null
  pkill -f "vite --port $PORT" 2>/dev/null
  sleep 0.3
  exec 2>&3 3>&-
  return 0
}
trap cleanup EXIT

# 3) 검증 실행
scripts=("verify-search.mjs" "verify-export.mjs")
if [[ $# -gt 0 ]]; then
  scripts=("${1%.mjs}.mjs")
fi

failures=0
for script in "${scripts[@]}"; do
  printf "\n\033[1m── %s\033[0m\n" "$script"
  (cd "$HERE" && node "$script") || failures=$((failures + 1))
done

printf "\n"
if [[ "$failures" -eq 0 ]]; then
  printf "\033[1;32m[완료]\033[0m UI 검증 통과\n"
else
  err "UI 검증 실패 ${failures}건"
  exit 1
fi
