#!/usr/bin/env bash
# 로컬 dmg 생성 — node_modules / sidecar 바이너리 / Tauri 빌드를 한 번에 처리.
# clone 직후 `npm run dmg` 한 명령으로 로컬 검증용 dmg 생성 가능.
# (정식 릴리스는 `npm run release -- <버전>` → 태그 push → CI가 빌드·서명·배포.)

set -euo pipefail

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
ok()   { printf "\033[1;32m[완료]\033[0m %s\n" "$1"; }
err()  { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

# === 0. 빌드 도구 검증 (Tauri 빌드는 cargo 필요. 그 외는 build-binaries.sh가 검증) ===
if ! command -v cargo &>/dev/null; then
  err "cargo가 필요합니다 — Rust 설치: https://rustup.rs"
  exit 1
fi

# === 1. node_modules 보장 ===
if [[ ! -d node_modules ]]; then
  info "node_modules 없음 — npm ci 실행"
  npm ci
  ok "npm ci 완료"
else
  ok "node_modules 존재"
fi

# === 2. sidecar 바이너리 빌드 (캐시 적용) ===
info "sidecar 바이너리 빌드 (이미 있으면 skip)"
bash scripts/build-binaries.sh

# === 3. Codex 스킬 산출물 생성 (.claude/skills → .agents/skills, CLAUDE.md → AGENTS.md) ===
info "Codex 스킬 산출물 생성 (gen-agent-skills)"
bash scripts/gen-agent-skills.sh

# === 4. 텔레메트리 키 주입 (선택) ===
# 로컬 dmg에도 Sentry/Aptabase를 담고 싶을 때만. gitignore된 .env.release가 있으면 로드한다.
# 없으면 빈 키로 빌드(원격 전송 없음) — 검증용 dmg엔 이걸로 충분하다.
# JUNMIT_SENTRY_DSN / JUNMIT_APTABASE_KEY는 option_env!이 컴파일 시 읽으므로,
# 값이 바뀌어도 소스가 그대로면 cargo가 재컴파일을 안 할 수 있어 main.rs를 touch해 강제한다.
if [[ -f .env.release ]]; then
  info "로컬 텔레메트리 키 로드 (.env.release)"
  set -a; source .env.release; set +a
  touch src-tauri/src/main.rs
fi

# === 5. Tauri 빌드 (frontend + Rust + bundle) ===
info "Tauri 빌드 시작"
npm run tauri build
ok "Tauri 빌드 완료"

# === 4. 결과 안내 ===
DMG_DIR="src-tauri/target/release/bundle/dmg"
if [[ -d "$DMG_DIR" ]] && compgen -G "$DMG_DIR/*.dmg" > /dev/null; then
  echo ""
  echo "=== 배포 준비 완료 ==="
  echo ""
  echo "생성된 dmg:"
  ls -lh "$DMG_DIR"/*.dmg
  echo ""
  echo "팀원에게 전달 시:"
  echo "  1. 위 dmg 파일 공유"
  echo "  2. 팀원: dmg 마운트 → Junmit.app을 Applications로 드래그"
  echo "  3. 첫 실행 시 \"확인되지 않은 개발자\" 경고 우회:"
  echo "     시스템 설정 → 개인정보 보호 및 보안 → 하단 \"차단되었지만 열기\" 클릭"
  echo ""
  echo "※ 이 스크립트(npm run dmg)는 로컬 검증용 dmg를 만듭니다."
  echo "  정식 릴리스(앱 내 자동 업데이트 대상)는:"
  echo "    npm run release -- X.Y.Z"
  echo "  버전 3곳 동기화 + 태그 push 후 .github/workflows/release.yml이"
  echo "  빌드·서명·GitHub Release·latest.json까지 자동 처리합니다."
else
  err "dmg 생성 실패: $DMG_DIR 비어있음"
  exit 1
fi
