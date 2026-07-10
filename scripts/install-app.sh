#!/bin/sh
# Junmit 설치 스크립트 (curl 배포용). Release 자산으로 `install.sh` 이름으로 업로드된다.
#
# 사용:
#   curl -fsSL https://github.com/bobs-devlog/junmit/releases/latest/download/install.sh | sh
#
# 왜 이 방식인가:
#   브라우저로 .dmg를 받으면 파일에 격리(com.apple.quarantine) 속성이 붙어, 게이트키퍼가
#   "확인되지 않은 개발자입니다" 경고를 띄운다(공증 없는 앱). curl로 받아 tar로 풀면 격리
#   속성이 붙지 않아 경고 없이 바로 실행된다 — Apple 공증($99/년) 없이 무료로 마찰을 없애는 통로.
#
# 개발자용(선택): JUNMIT_INSTALL_DIR 환경변수로 설치 위치를 바꿀 수 있다(테스트·비관리자 계정용).

set -eu

REPO="bobs-devlog/junmit"
ASSET="Junmit_aarch64.app.tar.gz"
APP="Junmit.app"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

info() { printf '\033[0;34m▸\033[0m %s\n' "$1"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# 1. 아키텍처 확인 (Apple Silicon 전용)
[ "$(uname -m)" = "arm64" ] || fail "이 앱은 Apple Silicon(M1 이후) Mac 전용입니다. 현재 기기: $(uname -m)"

# 2. macOS 버전 확인 (14.4 이상 — 시스템 오디오 캡처 API 요구)
osver=$(sw_vers -productVersion)
osmajor=$(echo "$osver" | cut -d. -f1)
osminor=$(echo "$osver" | cut -d. -f2)
if [ "$osmajor" -lt 14 ] || { [ "$osmajor" -eq 14 ] && [ "${osminor:-0}" -lt 4 ]; }; then
  fail "macOS 14.4 이상이 필요합니다. 현재 버전: ${osver}"
fi

# 3. 설치 위치 결정 (관리자면 /Applications, 아니면 ~/Applications — sudo 불필요)
if [ -n "${JUNMIT_INSTALL_DIR:-}" ]; then
  DEST="$JUNMIT_INSTALL_DIR"
elif [ -w "/Applications" ]; then
  DEST="/Applications"
else
  DEST="$HOME/Applications"
fi
mkdir -p "$DEST"

# 4. 임시 작업 디렉토리 + 종료 시 정리
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# 5. 다운로드
info "Junmit 다운로드 중…"
curl -fSL --progress-bar "$URL" -o "$TMP/app.tar.gz" \
  || fail "다운로드에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."
[ -s "$TMP/app.tar.gz" ] || fail "다운로드된 파일이 비어 있습니다. 잠시 후 다시 시도해 주세요."

# 6. 압축 해제
info "압축 해제 중…"
tar -xzf "$TMP/app.tar.gz" -C "$TMP" || fail "압축 해제에 실패했습니다. 파일이 손상되었을 수 있습니다."
[ -d "$TMP/$APP" ] || fail "내려받은 압축 파일에서 ${APP}을(를) 찾지 못했습니다."

# 7. 기존 설치 제거 후 이동
if [ -d "$DEST/$APP" ]; then
  info "기존 버전을 정리하는 중…"
  rm -rf "$DEST/$APP"
fi
mv "$TMP/$APP" "$DEST/$APP" || fail "${DEST}(으)로 옮기지 못했습니다. 폴더 권한을 확인해 주세요."

# 8. 격리 속성 제거 (curl 경로엔 원래 없지만, 어떤 경로로 왔든 확실히 제거)
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

ok "설치 완료 — ${DEST}/${APP}"

# 9. 실행 (대화형 터미널에서 실행됐을 때만)
if [ -t 1 ]; then
  info "Junmit을 실행합니다…"
  open "$DEST/$APP" 2>/dev/null || true
fi
