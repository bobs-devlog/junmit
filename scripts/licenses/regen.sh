#!/usr/bin/env bash
# THIRD_PARTY_LICENSES.md 재생성 — 의존성 라이선스 고지를 한 파일로 조립한다.
#
# 출하 바이너리에 링크/동봉되는 의존성의 라이선스 전문을 모은다:
#   - Rust  : cargo-about (출하 타겟 aarch64-apple-darwin, build/dev-deps 제외 — about.toml)
#   - npm   : generate-license-file (프로덕션 의존성만)
#   - 동봉 모델·바이너리·글꼴 : header.md (도구로 못 뽑는 부분, 수동 유지)
#
# 의존성을 추가/갱신했을 때만 다시 돌리면 된다(매 빌드 자동화 아님).
#
# 사전 설치(개발자 1회):
#   cargo install cargo-about --features cli
#   (npm 쪽은 npx로 그때그때 받음)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$ROOT/THIRD_PARTY_LICENSES.md"
TMP_NPM="$(mktemp)"
TMP_CARGO="$(mktemp)"
trap 'rm -f "$TMP_NPM" "$TMP_CARGO"' EXIT

command -v cargo-about >/dev/null || { echo "cargo-about 필요: cargo install cargo-about --features cli" >&2; exit 1; }

echo "[1/3] npm 프로덕션 의존성 라이선스 수집..."
npx --yes generate-license-file --input "$ROOT/package.json" --output "$TMP_NPM" --overwrite

echo "[2/3] Rust(cargo) 의존성 라이선스 수집..."
( cd "$ROOT/src-tauri" && cargo about generate -c "$SCRIPT_DIR/about.toml" "$SCRIPT_DIR/about.hbs" -o "$TMP_CARGO" )

echo "[3/3] $OUT 조립..."
{
  cat "$SCRIPT_DIR/header.md"
  echo
  echo "## Rust 의존성 (cargo)"
  echo
  echo '```'
  cat "$TMP_CARGO"
  echo '```'
  echo
  echo "## JavaScript 의존성 (npm)"
  echo
  echo '```'
  cat "$TMP_NPM"
  echo '```'
} > "$OUT"

echo "완료: $OUT ($(wc -l < "$OUT" | tr -d ' ')줄)"
