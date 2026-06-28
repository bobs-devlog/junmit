#!/usr/bin/env bash
# 사용자 머신용 setup. 사용자 데이터(.venv, models, python-runtime)와 캘린더 권한 안내만 책임.
# AI CLI(claude/codex)는 온보딩 "AI 도구 선택" 화면이 설치·로그인을 보장하고, Atlassian MCP는
# 앱이 각 CLI의 junmit 전용 환경에 자동 등록하므로 여기서 할 일이 없다.
# sidecar 바이너리(whisper-cli, diarize, uv 등)는 앱 번들에 포함되어 있으므로 여기서 빌드하지 않는다.
# 바이너리 빌드는 scripts/build-binaries.sh (개발자 머신 전용).
set -euo pipefail

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
ok()   { printf "\033[1;32m[완료]\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m[경고]\033[0m %s\n" "$1"; }
err()  { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }

# 예기치 못한 실패(네트워크 끊김·디스크 부족 등)에 대한 친절한 catch-all 안내.
# 명시적 검증(ffmpeg/uv)은 각자 구체 메시지를 출력하고 exit하며,
# 그 분기들은 if 조건/else-exit 형태라 ERR을 트리거하지 않으므로 메시지가 중복되지 않는다.
trap 'err "설치 중 예기치 못한 오류가 발생했습니다. 인터넷 연결과 디스크 여유 공간을 확인한 뒤 다시 시도해주세요."' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# APP_DATA_DIR (~/Library/Application Support/app.junmit): 모델, venv 등 사용자 데이터.
# 환경변수로 오버라이드 가능 (앱이 실행 시 주입).
APP_DATA_DIR="${APP_DATA_DIR:-$HOME/Library/Application Support/app.junmit}"
MODELS_DIR="${MODELS_DIR:-$APP_DATA_DIR/models}"
VENV_DIR="${VENV_DIR:-$APP_DATA_DIR/.venv}"
# uv가 Python 인터프리터를 다운로드하는 위치 — 사용자 데이터 영역에 두면 앱 정리 시 같이 삭제 가능.
export UV_PYTHON_INSTALL_DIR="$APP_DATA_DIR/python-runtime"
mkdir -p "$APP_DATA_DIR" "$MODELS_DIR" "$UV_PYTHON_INSTALL_DIR"

# 선택된 AI CLI — 앱 "AI 도구 선택"이 기록한 값(claude/codex). 파일이 없거나 값이 다르면
# claude(앱 기본값과 동일)로 본다. 표시 라벨에만 사용 — 설치·로그인은 양쪽 모두 온보딩
# 선택 화면이 junmit 전용 환경 기준으로 보장하므로 setup에서 검증하지 않는다.
ACTIVE_CLI="claude"
if [[ -f "$APP_DATA_DIR/active_cli" ]]; then
  ACTIVE_CLI="$(tr -d '[:space:]' < "$APP_DATA_DIR/active_cli")"
  [[ "$ACTIVE_CLI" == "codex" ]] || ACTIVE_CLI="claude"
fi
LLM_LABEL="Claude Code"
[[ "$ACTIVE_CLI" == "codex" ]] && LLM_LABEL="Codex"

# uv 바이너리 (앱 번들 또는 워크스페이스 bin/에 있음)
UV="$SCRIPT_DIR/bin/uv"
if [[ ! -x "$UV" ]]; then
  err "uv 바이너리가 없습니다: $UV"
  err "개발자 환경이라면 'npm run build-binaries' 실행"
  exit 1
fi

echo "=== Junmit 설치 ==="
echo ""
echo "엔진:"
echo "  - 전사: whisper.cpp (Metal GPU 가속)"
echo "  - 화자분리: pyannote.audio (MPS GPU 가속)"
echo "  - 회의록: $LLM_LABEL (대화형)"
echo ""

# macOS 확인
if [[ "$(uname)" != "Darwin" ]]; then
  err "macOS만 지원합니다."
  exit 1
fi

# ffmpeg 확인 (오디오 변환에 필요)
if ! command -v ffmpeg &>/dev/null; then
  if command -v brew &>/dev/null; then
    info "ffmpeg 설치 중..."
    brew install ffmpeg
  else
    err "Homebrew가 필요합니다 (ffmpeg 설치용)."
    err ""
    err "공식 가이드를 따라 Homebrew를 설치한 뒤 setup을 다시 시도하세요:"
    err ""
    err "  https://brew.sh/ko/"
    err ""
    exit 1
  fi
fi
ok "ffmpeg 확인됨"

# Python 검증/설치는 uv가 자동 처리 (시스템 python3 의존 X).
# AI CLI(claude/codex) 검증은 하지 않는다 — 온보딩 "AI 도구 선택" 화면이 공식 curl 인스톨러로
# 설치하고 junmit 전용 환경 로그인까지 확인한 뒤에만 setup으로 진입한다(Node.js도 불필요).

# === Python venv + pyannote.audio (화자 분리 엔진) ===
# 무거운 Whisper 모델 다운로드 전에 먼저 검증 — SSL/네트워크 문제를 fail-fast로 노출.
info "Python 환경 확인 중..."
if [[ -d "$VENV_DIR" ]] && "$VENV_DIR/bin/python3" -c "import pyannote.audio" 2>/dev/null; then
  ok "pyannote.audio 이미 설치됨"
else
  info "Python 3.12 인터프리터 다운로드 중 (uv)..."
  "$UV" python install 3.12

  info "Python 가상환경 생성 중..."
  "$UV" venv --clear --python 3.12 "$VENV_DIR"

  # uv pip install — 시스템 python에 의존하지 않음.
  # --python 인자로 venv 인터프리터 명시.
  # 버전 정책: ~=N.M.P (compatible release) — 패치 버전은 자동으로 받아 보안 패치
  # 누림. 마이너/메이저 업그레이드는 의도적 (호환성 검증 후 install.sh 수정).
  info "PyTorch + pyannote.audio 설치 중..."
  "$UV" pip install --python "$VENV_DIR/bin/python3" \
    "torch~=2.11.0" \
    "torchaudio~=2.11.0" \
    "pyannote.audio~=4.0.4" \
    "huggingface_hub~=1.12.0"
  ok "PyTorch + pyannote.audio 설치 완료"

  # MPS 지원 확인
  "$VENV_DIR/bin/python3" -c "
import torch
if torch.backends.mps.is_available():
    print('MPS (Metal GPU) 가속 사용 가능')
else:
    print('MPS 미지원 — CPU 모드로 동작합니다')
"
fi

# === Whisper 모델 다운로드 (Python 환경 검증 후 무거운 다운로드 시작) ===
WHISPER_MODEL="$MODELS_DIR/ggml-large-v3-turbo.bin"
WHISPER_MODEL_TMP="$MODELS_DIR/ggml-large-v3-turbo.bin.tmp"
if [[ -f "$WHISPER_MODEL" ]]; then
  ok "Whisper large-v3-turbo 모델 이미 다운로드됨"
else
  # 이전에 중단된 임시 파일이 있으면 삭제
  rm -f "$WHISPER_MODEL_TMP"
  info "Whisper large-v3-turbo 모델 다운로드 중 (~1.5GB)..."
  # -f: HTTP 에러(404·프록시 등) 시 실패 처리 — 에러 페이지가 모델 파일로 저장되는 것 방지.
  # --retry: 일시적 네트워크 끊김 자동 재시도.
  curl -fL --retry 3 --retry-delay 2 --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
    -o "$WHISPER_MODEL_TMP"
  # 다운로드 완료 후에만 최종 파일로 이동
  mv "$WHISPER_MODEL_TMP" "$WHISPER_MODEL"
  ok "Whisper large-v3-turbo 모델 다운로드 완료"
fi

# pyannote 화자분리 모델은 앱 번들에 동봉되어 있다 (resources/models/pyannote,
# CC-BY-4.0 — build-binaries.sh가 배치). HF 계정·토큰·prefetch 단계 없음.

# Atlassian MCP는 앱이 각 CLI의 junmit 전용 환경에 자동 등록(claude: .claude.json 베이크,
# codex: config.toml 베이크)하므로 setup에서 등록하지 않는다.

echo ""
info "캘린더 연동 (최초 1회):"
echo "  시스템 설정 → 인터넷 계정 → Google 계정 추가 → 캘린더 동기화 켜기"
echo "  (이미 연동되어 있으면 이 단계는 건너뛰세요)"
echo ""

info "Atlassian 연동은 첫 Confluence 등록 시 앱이 로그인을 안내합니다."
echo ""

echo ""
echo "=== 설치 완료 ==="
echo ""
echo "엔진:"
echo "  전사:     whisper.cpp (Metal GPU 가속)"
echo "  화자분리: pyannote.audio (MPS GPU 가속)"
echo "  회의록:   $LLM_LABEL (대화형)"
echo ""
echo "설치 위치:"
echo "  모델:           $MODELS_DIR"
echo "  Python venv:    $VENV_DIR"
echo "  Python runtime: $UV_PYTHON_INSTALL_DIR"
echo ""
echo "Junmit 앱을 실행하세요."
echo ""
