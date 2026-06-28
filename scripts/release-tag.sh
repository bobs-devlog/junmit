#!/usr/bin/env bash
# 릴리스 태그 헬퍼 — 버전 3곳(package.json·tauri.conf.json·Cargo.toml)을 한 번에 맞추고
# 커밋·태그·push까지 수행한다. push되면 .github/workflows/release.yml이 빌드·ad-hoc 서명·
# 업데이터(minisign) 서명·GitHub Release·latest.json 생성을 자동 처리한다.
#
#   bash scripts/release-tag.sh 0.1.1
#
# 업데이터가 비교하는 기준은 tauri.conf.json의 version이며, 태그(vX.Y.Z)와 일치해야 한다.
# 이 스크립트가 셋을 항상 동기화해 버전 드리프트(흔한 사고)를 막는다.

set -euo pipefail

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
err()  { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  err "사용법: bash scripts/release-tag.sh <버전>   예) 0.1.1"
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  err "버전은 X.Y.Z 형식이어야 합니다 (받은 값: $VERSION)"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG="v$VERSION"

# 태그 중복 방지
if git rev-parse "$TAG" >/dev/null 2>&1; then
  err "태그 $TAG 가 이미 존재합니다."
  exit 1
fi
# 깨끗한 작업트리 요구 — 버전 커밋만 깔끔히 담기게
if [[ -n "$(git status --porcelain)" ]]; then
  err "커밋되지 않은 변경이 있습니다. 먼저 정리/커밋한 뒤 다시 실행하세요."
  git --no-pager status --short >&2
  exit 1
fi

info "버전을 $VERSION 로 동기화…"

# JSON 2개 — 최상위 "version" 값만 raw 텍스트로 교체(첫 매치). 전체 재포맷을 피해
# 버전 외 라인은 그대로 보존한다(JSON.stringify로 다시 쓰면 배열 포맷 등이 바뀌어
# 무관한 diff가 생긴다).
node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    let s = fs.readFileSync(f, "utf8");
    s = s.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`);
    fs.writeFileSync(f, s);
  }
' "$VERSION"

# Cargo.toml — [package] 블록의 version만 교체(의존성의 version은 건드리지 않음)
awk -v v="$VERSION" '
  /^\[/ { inpkg = ($0 == "[package]") }
  inpkg && /^version[[:space:]]*=/ && !done { sub(/=.*/, "= \"" v "\""); done = 1 }
  { print }
' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp && mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

# Cargo.lock — junmit-app 패키지 블록의 version만 교체(cargo 없이도 일관 유지)
awk -v v="$VERSION" '
  $0 == "name = \"junmit-app\"" { inpkg = 1 }
  inpkg && /^version = / { sub(/=.*/, "= \"" v "\""); inpkg = 0 }
  { print }
' src-tauri/Cargo.lock > src-tauri/Cargo.lock.tmp && mv src-tauri/Cargo.lock.tmp src-tauri/Cargo.lock

echo ""
info "변경 내용:"
git --no-pager diff --stat
echo ""
read -r -p "$TAG 로 커밋·태그·push 하시겠습니까? (Actions가 릴리스를 배포합니다) [y/N] " ans
if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
  err "취소됨. 버전 변경은 작업트리에 남아 있습니다 (git checkout 으로 되돌릴 수 있음)."
  exit 1
fi

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
# 버전이 이미 목표값과 같으면(첫 릴리스 등) 스테이징이 비어 commit이 실패하므로,
# 그 경우엔 새 커밋 없이 현재 HEAD에 태그만 붙인다.
if git diff --cached --quiet; then
  info "버전이 이미 $VERSION 입니다. 새 커밋 없이 현재 커밋에 태그만 붙입니다."
else
  git commit -m "chore(release): $TAG"
fi
git tag "$TAG"
git push origin HEAD
git push origin "$TAG"

echo ""
info "완료 — GitHub Actions가 $TAG 를 빌드·서명·배포합니다."
info "진행 상황: GitHub repo의 Actions 탭에서 확인하세요."
