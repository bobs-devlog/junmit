#!/usr/bin/env bash

# 화자 분리 파이프라인
#
# 1) pyannote.audio (Python venv) 로 화자 분리 → diarize.json (raw)
# 2) diarize (Swift) 로 segments와 병합
#    - 세그먼트 시간 overlap 매칭 (단어 레벨은 한국어 whisper 타임스탬프 부정확으로 미사용)
#    - "- A - B" 대시 대화 패턴 분할 (텍스트 손상 없이 string split)
# 3) diarize.json, recording.json, transcript.txt 출력
#
# 설계 결정:
#  - 엔진은 pyannote.audio
#  - Python/torch/pyannote venv 의존성은 앱이 install.sh로 자동 설치
#  - max_speakers는 meeting.json의 attendees 길이를 상한으로 전달 (정확 강제 X — 불참자/외부 참여자 가능)
do_diarize() {
  local session_dir="$1"
  local max_speakers="${2:-}"

  # max_speakers 미지정 시 참석자 수로 자동 계산 (Rust가 meeting.json attendees 길이를
  # MAX_SPEAKERS로 전달). 참석자 수가 정확하면 over-merge(여러 화자가 한 SPEAKER로
  # 합쳐지는 현상) 방지에 큰 효과. 0이면 안전한 기본값 10.
  local speaker_hint_source="attendees"
  if [[ -z "$max_speakers" || "$max_speakers" -eq 0 ]]; then
    max_speakers="${MAX_SPEAKERS:-0}"
    if [[ -z "$max_speakers" || "$max_speakers" -eq 0 ]]; then
      max_speakers=10
      speaker_hint_source="default"
    fi
  fi
  local wav_file="$session_dir/recording.wav"
  local segments_file="$session_dir/segments.json"
  local diarize_file="$session_dir/diarize.json"
  local transcript_file="$session_dir/transcript.txt"
  local recording_json="$session_dir/recording.json"

  if [[ ! -f "$segments_file" ]]; then
    err "전사 세그먼트 파일이 없습니다: $segments_file"
    exit 1
  fi

  local diarize_bin="$SCRIPT_DIR/bin/diarize"
  if [[ ! -x "$diarize_bin" ]]; then
    err "diarize 바이너리가 없습니다. install.sh를 실행하세요."
    exit 1
  fi

  local pyannote_script="$SCRIPT_DIR/lib/pyannote_diarize.py"
  if [[ ! -f "$VENV_DIR/bin/python3" ]]; then
    err "Python 환경이 없습니다. install.sh를 실행하세요."
    exit 1
  fi

  # 화자분리 모델은 앱 번들 동봉 (CC-BY-4.0 — build-binaries.sh가 배치)
  local pyannote_model_dir="$SCRIPT_DIR/models/pyannote"
  if [[ ! -f "$pyannote_model_dir/config.yaml" ]]; then
    err "화자분리 모델이 없습니다: $pyannote_model_dir"
    err "앱 번들이 손상되었을 수 있습니다. 앱을 다시 설치해주세요."
    exit 1
  fi

  local diarize_input="$wav_file"

  info "  pyannote.audio (MPS GPU 가속) 사용"
  # 화자 수 탐색 기준 + 출처 — 진행 패널이 파싱해 "참석자 N명 기준" / 기본값 안내로 표시
  # (형식 변경 시 ProcessingPanel의 파서와 함께 수정).
  echo "[speaker-hint] ${speaker_hint_source} ${max_speakers}"

  if ! "$VENV_DIR/bin/python3" "$pyannote_script" \
      "$diarize_input" "$diarize_file" "$pyannote_model_dir" "$max_speakers"; then
    err "화자 분리에 실패했습니다."
    exit 1
  fi

  if [[ ! -s "$diarize_file" ]]; then
    err "화자 분리 결과가 비어있습니다."
    exit 1
  fi

  # diarize로 merge (세그먼트 시간 overlap 매칭 + 대시 분할)
  if ! "$diarize_bin" \
      --diarize "$diarize_file" \
      --output "$diarize_file" \
      --segments "$segments_file" \
      --transcript "$transcript_file" \
      --recording-json "$recording_json"; then
    err "transcript 병합에 실패했습니다."
    exit 1
  fi

  local lines
  lines=$(wc -l < "$transcript_file" 2>/dev/null | tr -d ' ')
  ok "화자 분리 완료 (${lines}줄)"
}
