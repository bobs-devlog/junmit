#!/usr/bin/env bash
# 앱 번들에 들어갈 sidecar 바이너리(whisper-cli + dylibs, diarize,
# whisper-parse) + 메인 프로세스에 link되는 dynamic library
# (libNative.dylib — EventKit/AVFoundation TCC 통합) 빌드.
# 개발자/CI 머신에서만 실행. 사용자 머신에서는 호출하지 않음.
# 산출물은 워크스페이스의 resources/bin/ 디렉토리에 놓이고, tauri.conf.json의
# bundle.resources에 의해 빌드된 .app/Contents/Resources/bin/ 으로 복사됨.

set -euo pipefail

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
ok()   { printf "\033[1;32m[완료]\033[0m %s\n" "$1"; }
err()  { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$SCRIPT_DIR/resources/bin"
DEPS_DIR="$SCRIPT_DIR/.deps"

# 공통 의존성. cmake은 whisper.cpp 단계에서만 따로 체크.
for tool in swift git; do
  if ! command -v "$tool" &>/dev/null; then
    err "$tool이 필요합니다."
    exit 1
  fi
done

mkdir -p "$BIN_DIR" "$DEPS_DIR"

# === whisper.cpp 빌드 (Metal GPU 가속) ===
WHISPER_DIR="$DEPS_DIR/whisper.cpp"
if [[ -f "$BIN_DIR/whisper-cli" ]] && "$BIN_DIR/whisper-cli" --help &>/dev/null; then
  ok "whisper.cpp 이미 빌드됨"
else
  if ! command -v cmake &>/dev/null; then
    err "whisper.cpp 빌드를 위해 cmake가 필요합니다."
    exit 1
  fi
  # Native dylib는 보존하고 whisper 산출물만 정리
  rm -f "$BIN_DIR/whisper-cli" "$BIN_DIR"/libwhisper.* "$BIN_DIR"/libggml*.dylib 2>/dev/null

  info "whisper.cpp 빌드 중 (Metal GPU 가속)..."
  # 버전 핀 — dev 검증본(whisper 1.8.4 / ggml 0.9.8)에 고정한다. HEAD(1.9.x)는 정적
  # 빌드가 기본이라 libwhisper.*.dylib를 만들지 않아 CI에서 dylib 복사가 실패했었다.
  WHISPER_REF="v1.8.4"
  if [[ -d "$WHISPER_DIR/.git" ]]; then
    (cd "$WHISPER_DIR" && git fetch --depth 1 origin tag "$WHISPER_REF" --quiet && git checkout -q "$WHISPER_REF")
  else
    rm -rf "$WHISPER_DIR"
    git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
  fi

  (
    cd "$WHISPER_DIR"
    # BUILD_SHARED_LIBS=ON — libwhisper.*.dylib + libggml*.dylib(공유)를 만들어야
    # whisper-cli가 @rpath로 링크하는 dev 구성과 일치한다.
    cmake -B build -DBUILD_SHARED_LIBS=ON -DWHISPER_METAL=ON -DWHISPER_COREML=OFF -DCMAKE_BUILD_TYPE=Release
    cmake --build build --config Release -j"$(sysctl -n hw.ncpu)"
  )

  # 임시 디렉토리에 모은 후 한 번에 이동 (중단 시 부분 상태 방지)
  WHISPER_TMP="$BIN_DIR/.whisper-install-tmp"
  rm -rf "$WHISPER_TMP"
  mkdir -p "$WHISPER_TMP"
  cp "$WHISPER_DIR/build/bin/whisper-cli" "$WHISPER_TMP/"
  cp "$WHISPER_DIR/build/src/libwhisper."*.dylib "$WHISPER_TMP/"
  cp "$WHISPER_DIR/build/ggml/src/libggml."*.dylib "$WHISPER_TMP/" 2>/dev/null || true
  cp "$WHISPER_DIR/build/ggml/src/libggml-base."*.dylib "$WHISPER_TMP/" 2>/dev/null || true
  cp "$WHISPER_DIR/build/ggml/src/libggml-cpu."*.dylib "$WHISPER_TMP/" 2>/dev/null || true
  cp "$WHISPER_DIR/build/ggml/src/ggml-blas/libggml-blas."*.dylib "$WHISPER_TMP/" 2>/dev/null || true
  cp "$WHISPER_DIR/build/ggml/src/ggml-metal/libggml-metal."*.dylib "$WHISPER_TMP/" 2>/dev/null || true

  mv "$WHISPER_TMP"/* "$BIN_DIR/"
  rm -rf "$WHISPER_TMP"

  ok "whisper.cpp 빌드 완료"
fi

# === Swift CLI (diarize, whisper-parse, apply-edits, mention-cache, adf) ===
SWIFT_SRC="$SCRIPT_DIR/swift-cli/diarize"
DIARIZE_BIN="$BIN_DIR/diarize"
PARSE_BIN="$BIN_DIR/whisper-parse"
APPLY_EDITS_BIN="$BIN_DIR/apply-edits"
MENTION_CACHE_BIN="$BIN_DIR/mention-cache"
ADF_BIN="$BIN_DIR/adf"
# 재빌드 필요 판정 — 바이너리 부재/손상이거나 소스가 빌드본보다 새로우면(stale) 재빌드.
# (`--help`만 보고 건너뛰면 소스만 고쳐도 옛 바이너리를 조용히 쓰는 사고가 남.)
swift_build_needed=0
for b in "$DIARIZE_BIN" "$PARSE_BIN" "$APPLY_EDITS_BIN" "$MENTION_CACHE_BIN" "$ADF_BIN"; do
  if [[ ! -x "$b" ]] || ! "$b" --help &>/dev/null; then
    swift_build_needed=1; break
  fi
  # Sources/ 또는 Package.swift에 이 바이너리보다 새 파일이 하나라도 있으면 stale.
  if [[ -n "$(find "$SWIFT_SRC/Sources" "$SWIFT_SRC/Package.swift" -type f -newer "$b" -print -quit 2>/dev/null)" ]]; then
    swift_build_needed=1; break
  fi
done
if [[ "$swift_build_needed" -eq 0 ]]; then
  ok "Swift CLI 이미 빌드됨 (소스 변경 없음)"
else
  info "Swift CLI 빌드 중..."
  (cd "$SWIFT_SRC" && swift build -c release)
  cp "$SWIFT_SRC/.build/release/diarize" "$BIN_DIR/"
  cp "$SWIFT_SRC/.build/release/whisper-parse" "$BIN_DIR/"
  cp "$SWIFT_SRC/.build/release/apply-edits" "$BIN_DIR/"
  cp "$SWIFT_SRC/.build/release/mention-cache" "$BIN_DIR/"
  cp "$SWIFT_SRC/.build/release/adf" "$BIN_DIR/"
  ok "Swift CLI 빌드 완료"
fi

# === uv (Astral) — Python 인터프리터/패키지 매니저 ===
# uv가 portable Python을 다운로드하므로 사용자는 시스템 python3을 설치할 필요 없음.
# Apple Silicon 전용 빌드 사용.
UV_BIN="$BIN_DIR/uv"
if [[ -x "$UV_BIN" ]] && "$UV_BIN" --version &>/dev/null; then
  ok "uv 이미 다운로드됨"
else
  info "uv 다운로드 중 (Astral standalone)..."
  UV_TMP=$(mktemp -d)
  curl -fsSL --retry 3 \
    "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz" \
    | tar -xz -C "$UV_TMP"
  cp "$UV_TMP/uv-aarch64-apple-darwin/uv" "$BIN_DIR/uv"
  chmod +x "$BIN_DIR/uv"
  rm -rf "$UV_TMP"
  ok "uv 다운로드 완료 ($("$UV_BIN" --version))"
fi

# === pyannote 화자분리 모델 (앱 번들 동봉) ===
# pyannote/speaker-diarization-community-1 — CC-BY-4.0 (© pyannoteAI), 출처 표기 시 재배포 허용.
# HF 허브의 게이트는 다운로드 절차일 뿐 법적 제한이 아니므로 개발자가 받아 동봉한다.
# 사용자는 HF 계정·토큰·약관 동의가 전부 불필요해진다. 다운로드는 개발자 머신 최초 1회만.
PYANNOTE_REPO="pyannote/speaker-diarization-community-1"
PYANNOTE_REV="3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
PYANNOTE_DIR="$SCRIPT_DIR/resources/models/pyannote"
if [[ -f "$PYANNOTE_DIR/config.yaml" ]]; then
  ok "pyannote 모델 이미 배치됨"
else
  # 임시 디렉토리에 모은 후 한 번에 이동 (중단 시 부분 상태 방지 — whisper와 동일 패턴)
  PYANNOTE_TMP="$SCRIPT_DIR/resources/models/.pyannote-tmp"
  rm -rf "$PYANNOTE_TMP"
  mkdir -p "$PYANNOTE_TMP"
  CACHED_SNAPSHOT="${HF_HOME:-$HOME/.cache/huggingface}/hub/models--pyannote--speaker-diarization-community-1/snapshots/$PYANNOTE_REV"
  if [[ -f "$CACHED_SNAPSHOT/config.yaml" ]]; then
    info "pyannote 모델 복사 중 (HF 캐시 재사용)..."
    cp -RL "$CACHED_SNAPSHOT/" "$PYANNOTE_TMP/"
  else
    if [[ -z "${HF_TOKEN:-}" ]]; then
      err "pyannote 모델 다운로드에 HF_TOKEN이 필요합니다 (gated repo — 개발자 최초 1회)."
      err "  1) https://huggingface.co/$PYANNOTE_REPO 에서 로그인 + 약관 동의"
      err "  2) HF_TOKEN=hf_... npm run build-binaries"
      exit 1
    fi
    info "pyannote 모델 다운로드 중 (~31MB)..."
    "$UV_BIN" tool run --from huggingface_hub hf download "$PYANNOTE_REPO" \
      --revision "$PYANNOTE_REV" --local-dir "$PYANNOTE_TMP"
    rm -rf "$PYANNOTE_TMP/.cache"  # hf download가 남기는 메타데이터 — 번들 불필요
  fi
  # config.yaml 없는 부분 상태 디렉토리가 남아 있으면 mv가 그 안으로 들어가므로 먼저 제거
  rm -rf "$PYANNOTE_DIR"
  mv "$PYANNOTE_TMP" "$PYANNOTE_DIR"
  ok "pyannote 모델 배치 완료 (CC-BY-4.0, © pyannoteAI)"
fi

# === Native dylib (메인 앱 프로세스에 link되어 TCC를 bundle identity로 귀속) ===
SYSTEM_SRC="$SCRIPT_DIR/swift-cli/system"
SYSTEM_LIB="$BIN_DIR/libNative.dylib"
SYSTEM_PKG_LIB="$SYSTEM_SRC/.build/release/libNative.dylib"
info "Native 빌드 중..."
(cd "$SYSTEM_SRC" && swift build -c release)
cp "$SYSTEM_PKG_LIB" "$SYSTEM_LIB"
install_name_tool -id "@rpath/libNative.dylib" "$SYSTEM_LIB"
ok "Native 빌드 완료"

echo ""
ok "모든 sidecar 바이너리 빌드 완료: $BIN_DIR"
