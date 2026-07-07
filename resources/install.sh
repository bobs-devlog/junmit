#!/usr/bin/env bash
# 사용자 머신용 setup. 사용자 데이터(.venv, models, python-runtime)와 캘린더 권한 안내만 책임.
# AI CLI(claude/codex/antigravity)는 온보딩 "AI 도구 선택" 화면이 설치·로그인을 보장하므로
# 여기서 할 일이 없다.
# 단 로컬 AI(mlx)는 CLI가 아니라서 이 스크립트가 런타임(mlx-vlm)·모델 다운로드까지 책임진다
# (INSTALL_MODE=model, 아래 참조).
# sidecar 바이너리(whisper-cli, diarize, uv 등)는 앱 번들에 포함되어 있으므로 여기서 빌드하지 않는다.
# 바이너리 빌드는 scripts/build-binaries.sh (개발자 머신 전용).
set -euo pipefail

info() { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
ok()   { printf "\033[1;32m[완료]\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m[경고]\033[0m %s\n" "$1"; }
err()  { printf "\033[1;31m[오류]\033[0m %s\n" "$1" >&2; }

# 용량 기반 다운로드 진행 표시 — $1 감시 경로(파일/디렉토리), $2 예상 MB, $3 다운로드 프로세스 PID.
# 앱(SetupScreen)이 "(NN%)"로 게이지를, "MB" 포함 줄을 본문으로 표기한다. 본문엔 직전 샘플
# 델타로 계산한 실시간 속도·ETA도 함께 싣는다 — 대용량 구간에서 진행 중임이 더 분명해진다.
# curl/HF 자체 진행바를 안 쓰는 이유(둘 다 실측): curl -L은 리다이렉트 응답마다 바를 새로
# 그려 시작 직후 100%→0%로 보이고, HF 바는 파일 개수 기준이라 수 GB 샤드 동안 멈춘 듯 보인다.
progress_du() {
  local target="$1" total_mb="$2" pid="$3" cur_kb cur_mb pct
  local prev_mb=0 prev_ts=0 now dmb dt speed speed_ema=0 rem eta extra
  while kill -0 "$pid" 2>/dev/null; do
    cur_kb=$(du -sk "$target" 2>/dev/null | cut -f1 || echo 0)
    cur_mb=$(( cur_kb * 1024 / 1000000 ))  # 십진 MB — Finder·모델 용량 표기(6.8GB 등)와 단위 통일
    # 총량은 예상값이라 실측(부가 파일·블록 오버헤드)이 넘칠 수 있다 — 표시가 "6748/6700"처럼
    # 모순되지 않게 총량으로 클램프 (게이지도 99%에 머묾, 완료 판정은 wait가 담당).
    [[ $cur_mb -gt $total_mb ]] && cur_mb=$total_mb
    pct=$(( cur_mb * 100 / total_mb )); [[ $pct -gt 99 ]] && pct=99
    # 실시간 속도·ETA — 직전 샘플과의 델타. 초기·정체(0/음수 델타)는 생략해 "0MB/s" 깜빡임 방지.
    # 크기 뒤 괄호로 묶어 부가 정보로 구분(점 나열보다 가독성 좋음). 앱은 말미 "(NN%)"만 떼고
    # 나머지(이 괄호 포함)를 본문으로 표시한다 — SetupScreen의 (\d+%)$ strip이 %괄호만 제거.
    now=$(date +%s); extra=""
    if [[ $prev_ts -gt 0 ]]; then
      dt=$(( now - prev_ts )); dmb=$(( cur_mb - prev_mb ))
      if [[ $dt -gt 0 && $dmb -gt 0 ]]; then
        speed=$(( dmb / dt )); [[ $speed -lt 1 ]] && speed=1
        # EMA 평활(alpha≈1/3) — 순간 속도 노이즈로 속도·ETA가 요동치지 않게. 표시·ETA 모두 평활값 사용.
        if [[ $speed_ema -le 0 ]]; then speed_ema=$speed; else speed_ema=$(( (speed_ema * 2 + speed) / 3 )); fi
        rem=$(( total_mb - cur_mb )); eta=$(( rem / speed_ema ))
        if [[ $eta -ge 60 ]]; then extra=" (${speed_ema}MB/s, 약 $(( eta / 60 ))분 남음)"
        else extra=" (${speed_ema}MB/s, 약 ${eta}초 남음)"; fi
      fi
    fi
    echo "  받는 중... ${cur_mb}MB / ${total_mb}MB${extra} (${pct}%)"
    prev_mb=$cur_mb; prev_ts=$now
    sleep 3
  done
}

# 예기치 못한 실패(네트워크 끊김·디스크 부족 등)에 대한 친절한 catch-all 안내.
# 명시적 검증(uv)은 구체 메시지를 출력하고 exit하며,
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

# 선택된 AI 백엔드 — 앱 "AI 도구 선택"이 기록한 값(claude/codex/antigravity/mlx). 파일이 없거나
# 값이 다르면 claude(앱 기본값과 동일)로 본다. CLI들의 설치·로그인은 온보딩 선택 화면이 보장하므로
# setup에서 검증하지 않는다. mlx(로컬 LLM)만 이 스크립트가 런타임·모델 설치를 책임진다.
ACTIVE_CLI="claude"
if [[ -f "$APP_DATA_DIR/active_cli" ]]; then
  ACTIVE_CLI="$(tr -d '[:space:]' < "$APP_DATA_DIR/active_cli")"
  case "$ACTIVE_CLI" in claude|codex|antigravity|mlx) ;; *) ACTIVE_CLI="claude" ;; esac
fi
LLM_LABEL="Claude Code"; LLM_MODE="(대화형)"
case "$ACTIVE_CLI" in
  codex) LLM_LABEL="Codex" ;;
  antigravity) LLM_LABEL="Antigravity CLI" ;;
  mlx) LLM_LABEL="로컬 AI (Gemma 4 12B)"; LLM_MODE="(로컬·오프라인)" ;;
esac

# 로컬 LLM(MLX) 모델 — 사용자가 앱 "AI 도구 선택"에서 고른 변형(local_model 파일, Rust가 기록).
# 디렉토리명은 session.rs LOCAL_MODEL_* / local_meeting.py local_model_name()과 일치해야 함.
#   gemma-4-12b-4bit : 표준 (순수 4bit, 6.8GB, 실행 피크 ~9.4GB — 16GB Mac)
#   gemma-4-12b-qat  : 고품질 (혼합 정밀도, 11GB, 실행 피크 ~13GB — 24GB+ Mac)
LOCAL_MODEL_NAME="gemma-4-12b-4bit"
if [[ -f "$APP_DATA_DIR/local_model" ]]; then
  v="$(tr -d '[:space:]' < "$APP_DATA_DIR/local_model")"
  case "$v" in gemma-4-12b-4bit|gemma-4-12b-qat) LOCAL_MODEL_NAME="$v" ;; esac
fi
LOCAL_MODEL_REPO="mlx-community/gemma-4-12B-it-4bit"; LOCAL_MODEL_SIZE="약 6.8GB"; LOCAL_MODEL_MB=6773
if [[ "$LOCAL_MODEL_NAME" == "gemma-4-12b-qat" ]]; then
  LOCAL_MODEL_REPO="mlx-community/gemma-4-12B-it-qat-4bit"; LOCAL_MODEL_SIZE="약 11GB"; LOCAL_MODEL_MB=11020
fi
LOCAL_MODEL_DIR="$MODELS_DIR/mlx/$LOCAL_MODEL_NAME"
# 로컬 AI 런타임 패키지 (base·model 모드 공유 — 버전 정책은 model 모드 설치부 주석 참조)
# mlx-vlm·transformers는 == 정확 고정(~= 아님) — 범위 드리프트가 gemma4_unified 로딩을 깬다.
MLX_RUNTIME_PKGS=("mlx-vlm==0.6.3" "transformers==5.12.1" "truststore" "hf_transfer~=0.1.9")

# uv 바이너리 (앱 번들 또는 워크스페이스 bin/에 있음)
UV="$SCRIPT_DIR/bin/uv"
if [[ ! -x "$UV" ]]; then
  err "uv 바이너리가 없습니다: $UV"
  err "개발자 환경이라면 'npm run build-binaries' 실행"
  exit 1
fi

# 실행 모드 — 기초 설치(base)와 로컬 LLM 모델 다운로드(model)를 분리.
# base(기본): venv·whisper·pyannote 등 백엔드 중립 기초. model: 모델만(venv 선행 필요).
# 온보딩은 base → (mlx면) model 순, 설정 전환은 model만 재사용한다.
INSTALL_MODE="${INSTALL_MODE:-base}"

if [[ "$INSTALL_MODE" == "model" ]]; then
  echo "=== 로컬 AI 모델 준비 (Gemma 4 12B) ==="
  echo ""
  if [[ ! -f "$VENV_DIR/bin/python3" ]]; then
    err "기초 설치가 먼저 필요합니다. 앱의 초기 설정을 완료해주세요."
    exit 1
  fi
  # 런타임 설치는 모델 존재 체크보다 앞 — base 재설치가 venv를 재생성(--clear)하면 모델은
  # 남고 런타임만 사라질 수 있어, 조기 종료가 런타임 복구를 건너뛰면 회의 시점에 터진다.
  # 이미 설치돼 있으면 uv가 수 초 내 no-op.
  # Gemma 4(unified 아키텍처)는 mlx-lm 정식 릴리스가 아직 미지원 — mlx-vlm이 실행 경로 (2026-07 실측).
  info "로컬 AI 런타임(mlx-vlm) 설치 중..."
  # mlx-vlm·transformers는 == 정확 고정 (MLX_RUNTIME_PKGS). ~= 범위는 in-range 신버전이
  # 새면서 gemma4_unified 프로세서 로딩을 깬다 — 실측 2026-07-07: mlx-vlm 0.6.4가 자체
  # from_pretrained(video processor를 processor_config.json에서 내부 생성) 경로를 버려
  # transformers AutoVideoProcessor로 빠지고, 그게 torchvision + video_preprocessor_config.json을
  # 요구하는데 mlx-community 리포엔 그 파일이 없어 로드 실패. 0.6.3은 동일 모델·transformers로
  # 정상(torchvision 불필요). transformers 5.13.0도 별건으로 깨짐 — mlx-lm 0.31 토크나이저 등록
  # (str 키)과 충돌해 import 자체가 죽는다 (AttributeError: 'str' object has no attribute
  # '__module__', 실측 2026-07-04). 상향은 mlx-lm/mlx-vlm 호환·gemma4_unified 로딩 실측 후 의도적으로.
  # truststore: python HTTP가 macOS 키체인을 신뢰하게 주입 — 사내 TLS 프록시(zscaler)가
  # 모델 CDN(us.aws.cdn.hf.co)을 가로채면 기본 인증서 묶음(certifi)으론 SSL 검증이 실패한다
  # (실측 2026-07-04: 주입 전 CERTIFICATE_VERIFY_FAILED / 주입 후 정상. curl·uv는 원래 키체인 사용).
  "$UV" pip install --python "$VENV_DIR/bin/python3" "${MLX_RUNTIME_PKGS[@]}"

  # 의도적으로 "이미 설치됨" 조기 종료를 두지 않는다 — 설치 여부 판정은 Rust
  # local_model_present()(config.json + 샤드 인덱스의 모든 가중치)가 단일 진실 원천이고,
  # 이 모드는 그 판정이 "부족"일 때만 라우팅된다. 여기서 자체 판정(예: config.json 존재)으로
  # 조기 종료하면 부분 다운로드(중단 잔재)가 "설치됨"으로 오판돼 다운로드가 영영 재개되지
  # 않는 루프에 갇힌다. snapshot_download는 이어받기라 완전 설치 상태여도 부담이 작다.

  info "로컬 AI 모델 다운로드 중 ($LOCAL_MODEL_SIZE, Gemma 4 12B)..."
  mkdir -p "$LOCAL_MODEL_DIR"
  # 사용자 데이터 영역에 직접 받는다(HF 캐시 아님) — 앱 정리 시 함께 삭제. 공개 리포라 토큰 불필요.
  # snapshot_download는 부분 다운로드 resume을 지원해 중단돼도 이어받는다.
  # 진행률은 "받은 용량" 기준으로 이 스크립트가 직접 출력 — HF 진행바는 파일 개수 기준이라
  # 수 GB 샤드 하나를 받는 몇 분 동안 갱신이 없어 UI 게이지가 0%에 멈춘 것처럼 보인다(실측).
  # 다운로드는 백그라운드, 진행 루프(progress_du)는 포그라운드 — 실패·취소 시 루프가 고아로
  # 남아 stdout 파이프를 잡고 있으면 Rust 스트림 스레드가 영영 안 끝난다.
  #
  # 다운로드 백엔드 — hf_transfer(Rust 병렬)로 회선을 채운다: 실측 단일 스트림 6.6MB/s →
  # 병렬 ~12MB/s(회선 천장)로 대략 절반 시간. HF_HUB_DISABLE_XET=1은 유지 — Xet은 청크를
  # 전역 캐시(~/.cache/huggingface/xet)에 받았다 재조립 때 목적지로 옮겨, 목적지 용량 기반
  # 게이지가 "정체 후 점프"로 보인다(실측). hf_transfer는 Xet과 달리 목적지 안
  # .incomplete(local_dir/.cache/huggingface/download/)에 병렬로 직접 이어써 진행률이 연속이다(실측).
  # 실패 시(일부 프록시 환경 등) huggingface_hub는 자동 폴백 없이 하드 에러라, 여기서 고전
  # 단일 스트림으로 재시도한다 — 두 백엔드가 같은 .incomplete를 써서 이어받는다(중복 다운로드 없음).
  download_model() {  # $1: 추가 env ("HF_HUB_ENABLE_HF_TRANSFER=1" 또는 빈 값=고전 단일 스트림)
    # hf_transfer의 "unauthenticated requests … set a HF_TOKEN" 경고는 Rust가 stderr로 직접
    # 출력해 아래 python logging 억제로 안 잡힌다(실측) — 출력 단계에서 걸러낸다. 공개 리포라
    # 토큰은 불필요이고(HF 계정 없이 쓰는 게 제품 원칙), 사용자에겐 조치 불가능한 소음이라서.
    env HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_PROGRESS_BARS=1 $1 \
      "$VENV_DIR/bin/python3" - "$LOCAL_MODEL_REPO" "$LOCAL_MODEL_DIR" \
      2> >(grep --line-buffered -vE "unauthenticated requests to the HF Hub|Please set a HF_TOKEN" >&2) <<'PY'
import logging, sys, warnings
import truststore
truststore.inject_into_ssl()  # 사내 TLS 프록시(zscaler) 대응 — macOS 키체인 신뢰 (위 설치 주석 참조)
warnings.filterwarnings("ignore")
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
from huggingface_hub import snapshot_download
repo, dest = sys.argv[1], sys.argv[2]
snapshot_download(repo_id=repo, local_dir=dest)
PY
  }

  download_model "HF_HUB_ENABLE_HF_TRANSFER=1" &
  DL_PID=$!
  progress_du "$LOCAL_MODEL_DIR" "$LOCAL_MODEL_MB" "$DL_PID"
  if ! wait "$DL_PID"; then
    warn "가속 다운로드에 실패해 표준 방식으로 다시 받습니다 (받던 데이터는 이어받음)..."
    download_model "" &
    DL_PID=$!
    progress_du "$LOCAL_MODEL_DIR" "$LOCAL_MODEL_MB" "$DL_PID"
    wait "$DL_PID"   # 실패 시 비0 종료 → set -e가 여기서 중단
  fi
  echo "  다운로드 완료 (100%)"

  # 스모크 테스트 — 현재 런타임에서 로드·생성 가능한지 지금 검증(첫 회의 때 실패 방지).
  info "모델 호환성 확인 중..."
  "$VENV_DIR/bin/python3" - "$LOCAL_MODEL_DIR" <<'PY'
import sys
from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import load_config
model, processor = load(sys.argv[1])
config = load_config(sys.argv[1])
prompt = apply_chat_template(processor, config, "안녕하세요", num_images=0)
generate(model, processor, prompt, max_tokens=5, verbose=False)
PY
  echo ""
  ok "로컬 AI 모델 준비 완료 ($LOCAL_MODEL_NAME)"
  echo "설치 위치: $LOCAL_MODEL_DIR"
  exit 0
fi

echo "=== Junmit 설치 ==="
echo ""
echo "엔진:"
echo "  - 전사: whisper.cpp (Metal GPU 가속)"
echo "  - 화자분리: pyannote.audio (MPS GPU 가속)"
echo "  - 회의록: $LLM_LABEL $LLM_MODE"
echo ""

# macOS 확인
if [[ "$(uname)" != "Darwin" ]]; then
  err "macOS만 지원합니다."
  exit 1
fi

# ffmpeg는 앱 번들에 동봉되어 있다(resources/bin/ffmpeg, audio-only LGPL — build-binaries.sh가 빌드).
# brew·사전 설치가 더 이상 필요 없다.

# Python 검증/설치는 uv가 자동 처리 (시스템 python3 의존 X).
# AI CLI(claude/codex/antigravity) 검증은 하지 않는다 — 온보딩 "AI 도구 선택" 화면이 공식 curl
# 인스톨러로 설치하고 로그인까지 확인한 뒤에만 setup으로 진입한다(Node.js도 불필요).

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

# 로컬 AI(mlx) 활성이면 런타임도 base가 함께 보장 — venv를 재생성(--clear)하는 주체가
# 이 모드라서다. 여기서 복구하지 않으면 "모델 파일은 있는데 런타임만 없는" 상태가 되는데,
# 프론트는 모델 존재만 보고 model 모드를 건너뛰므로 회의 시점 import 실패로만 표면화되는
# 복구 불가 막다른 길이 된다 (dev+release venv 재생성 실사고 2026-07-04). 설치돼 있으면 수 초 no-op.
if [[ "$ACTIVE_CLI" == "mlx" ]]; then
  info "로컬 AI 런타임(mlx-vlm) 확인 중..."
  "$UV" pip install --python "$VENV_DIR/bin/python3" "${MLX_RUNTIME_PKGS[@]}"
fi

# === Whisper 모델 다운로드 (Python 환경 검증 후 무거운 다운로드 시작) ===
# q8_0 양자화 모델을 쓴다: FP16(1.5GB)과 전사 품질은 동급이나 용량이 절반 근처(874MB)다(실측 —
# 한국어 본문·영어 고유명사 모두 FP16과 구분 불가, q5_0은 영어 이름 열화로 기각, large-v3는
# 3배 느리고 이점 없어 기각). Metal에서 turbo는 이미 빨라 양자화의 속도 이득은 없고 이득은 용량뿐.
WHISPER_MODEL="$MODELS_DIR/ggml-large-v3-turbo-q8_0.bin"
WHISPER_MODEL_TMP="$MODELS_DIR/ggml-large-v3-turbo-q8_0.bin.tmp"
# 구 FP16 모델(1.5GB) 정리 — q8_0로 전환하며 남은 파일이 디스크만 차지하지 않게 제거(1회성).
rm -f "$MODELS_DIR/ggml-large-v3-turbo.bin"
if [[ -f "$WHISPER_MODEL" ]]; then
  ok "Whisper large-v3-turbo 모델 이미 다운로드됨"
else
  # 이전에 중단된 임시 파일이 있으면 삭제
  rm -f "$WHISPER_MODEL_TMP"
  info "Whisper large-v3-turbo 모델 다운로드 중 (약 870MB)..."
  # -f: HTTP 에러(404·프록시 등) 시 실패 처리 — 에러 페이지가 모델 파일로 저장되는 것 방지.
  # --retry: 일시적 네트워크 끊김 자동 재시도. 진행 표시는 progress_du(정의부 주 참조).
  curl -fsSL --retry 3 --retry-delay 2 \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin" \
    -o "$WHISPER_MODEL_TMP" &
  CURL_PID=$!
  progress_du "$WHISPER_MODEL_TMP" 874 "$CURL_PID"
  wait "$CURL_PID"   # 실패 시 비0 종료 → set -e가 여기서 중단
  # 다운로드 완료 후에만 최종 파일로 이동
  mv "$WHISPER_MODEL_TMP" "$WHISPER_MODEL"
  ok "Whisper large-v3-turbo 모델 다운로드 완료"
fi

# 로컬 LLM(MLX) 모델은 기초 설치와 분리했다(INSTALL_MODE=model). 온보딩은 이 base 완료 후
# 별도 "모델 준비" 단계로, 설정 전환은 그 단계만 재사용한다. 여기(base)선 다루지 않는다.

# pyannote 화자분리 모델은 앱 번들에 동봉되어 있다 (resources/models/pyannote,
# CC-BY-4.0 — build-binaries.sh가 배치). HF 계정·토큰·prefetch 단계 없음.

echo ""
info "캘린더 연동 (최초 1회):"
echo "  시스템 설정 → 인터넷 계정 → Google 계정 추가 → 캘린더 동기화 켜기"
echo "  (이미 연동되어 있으면 이 단계는 건너뛰세요)"
echo ""

echo ""
echo "=== 설치 완료 ==="
echo ""
echo "엔진:"
echo "  전사:     whisper.cpp (Metal GPU 가속)"
echo "  화자분리: pyannote.audio (MPS GPU 가속)"
echo "  회의록:   $LLM_LABEL $LLM_MODE"
echo ""
echo "설치 위치:"
echo "  모델:           $MODELS_DIR"
echo "  Python venv:    $VENV_DIR"
echo "  Python runtime: $UV_PYTHON_INSTALL_DIR"
echo ""
echo "Junmit 앱을 실행하세요."
echo ""
