#!/usr/bin/env bash

# whisper.cpp로 전사 (Metal GPU 가속)
do_transcribe() {
  local session_dir="$1"
  local wav_file="$session_dir/recording.wav"
  local ffmpeg="$SCRIPT_DIR/bin/ffmpeg"  # 앱 동봉 (PATH 의존 제거)
  local whisper_cli="$SCRIPT_DIR/bin/whisper-cli"
  local whisper_model="$MODELS_DIR/ggml-large-v3-turbo.bin"
  local json_file="$session_dir/recording_whisper.json"

  if [[ ! -f "$wav_file" ]]; then
    err "녹음 파일이 없습니다: $wav_file"
    exit 1
  fi

  if [[ ! -f "$whisper_cli" ]]; then
    err "whisper-cli가 설치되어 있지 않습니다. install.sh를 실행하세요."
    exit 1
  fi

  info "  whisper.cpp (Metal GPU 가속) 사용"

  # whisper prompt priming — 용어 사전 + 참석자 이름. Rust(cmd_run_pipeline)가
  # vocabulary.json·meeting.json을 읽어 ", "로 결합해 WHISPER_PROMPT로 전달한다.
  local prompt_text="${WHISPER_PROMPT:-}"

  # whisper.cpp 실행
  # -ojf: Full JSON 출력 (세그먼트 timestamp 포함)
  # -of: 출력 파일 prefix, -l ko: 한국어
  # --max-context 0: 이전 텍스트를 컨텍스트로 사용하지 않음 (후반부 품질 저하 + 환각 방지)
  # --prompt: 용어 사전 + 참석자 이름 (전사 품질 향상)
  # VAD는 쓰지 않는다 — whisper.cpp 내장 VAD는 발화 구간을 이어붙여 디코딩하므로
  # 세그먼트가 과도하게 병합되고 전사 품질이 떨어진다(실측). 무음 환각은 전사 후
  # 세그먼트 단위 필터로 제거한다(아래 whisper-parse --silence-regions + denylist).
  local prompt_args=()
  if [[ -n "$prompt_text" ]]; then
    prompt_args=(--prompt "$prompt_text")
  fi

  DYLD_LIBRARY_PATH="$SCRIPT_DIR/bin" "$whisper_cli" \
    -m "$whisper_model" \
    -f "$wav_file" \
    -l ko \
    --max-context 0 \
    -ojf \
    -of "$session_dir/recording_whisper" \
    ${prompt_args[@]+"${prompt_args[@]}"} \
    --no-prints \
    >/dev/null 2>&1

  if [[ ! -f "$json_file" ]] || [[ ! -s "$json_file" ]]; then
    err "음성 인식에 실패했습니다."
    exit 1
  fi

  # === 무음 환각 필터용 '무음 구간' 산출 ===
  # 초반/중간 무음 구간을 whisper가 "감사합니다"·"한글자막 by~" 류 유튜브 자막 크레딧
  # 환각으로 채우는 한국어 whisper의 전형적 현상을 막는다. ffmpeg silencedetect로 -50dB
  # 미만(실발화 없음) 구간을 구해 whisper-parse에 넘기면, 그 안에 통째로 들어간 세그먼트를
  # 드롭한다(절대 음량 기준 — 비율이 아님. 실제 짧은 발화는 -45dB 이상이라 보존된다).
  # 임계 -50dB: 정상 발화 피크는 -40dB 이상, 무음 속 환각은 -60dB 안팎이라 그 사이를 가른다.
  # 산출 실패 시 인자 미전달 → 무음 드롭 생략(fail-open). 크레딧 문구 denylist는 whisper-parse 내장.
  local silence_file="$session_dir/silence_regions.json"
  "$ffmpeg" -i "$wav_file" -af "silencedetect=noise=-50dB:d=0.3" -f null /dev/null 2>&1 \
    | awk '
        /silence_start/ { s=$NF }
        /silence_end/   { gsub(/\|/,"",$0); for(i=1;i<=NF;i++) if($i=="silence_end:"){e=$(i+1)}
                          if(s!=""){ rows[n++]=s","e; s="" } }
        END {
          if(s!=""){ rows[n++]=s",1000000000" }
          printf "["
          for(i=0;i<n;i++){ printf "%s[%s]", (i?",":""), rows[i] }
          printf "]\n"
        }' > "$silence_file"

  local parse_silence_args=()
  if [[ -s "$silence_file" ]] && [[ "$(cat "$silence_file")" != "[]" ]]; then
    parse_silence_args=(--silence-regions "$silence_file")
  fi

  # whisper.cpp Full JSON → segments.json 변환
  #  - 환각 반복 제거 + 깨진 UTF-8 토큰 제외 + 무음/크레딧 환각 필터는 whisper-parse가 담당
  #  - 화자 매칭은 세그먼트 시간 overlap (단어 레벨 미사용 — diarize.sh 참고)
  local parse_bin="$SCRIPT_DIR/bin/whisper-parse"
  if [[ ! -x "$parse_bin" ]]; then
    err "whisper-parse 바이너리가 없습니다. install.sh를 실행하세요."
    exit 1
  fi

  "$parse_bin" \
    --input "$json_file" \
    --segments-output "$session_dir/segments.json" \
    ${parse_silence_args[@]+"${parse_silence_args[@]}"}

  # whisper.cpp 원본 JSON + 임시 무음 구간 파일 정리 (segments.json 추출 완료)
  rm -f "$json_file" "$silence_file"

  # === 무음 감지 ("녹음된 발화 없음" 판정) ===
  # 빈/무음 녹음은 whisper가 "시청해주셔서 감사합니다" 류 환각을 만들어 가짜 회의록이 된다.
  # 오디오 평균 음량(mean_volume)으로만 판정 — 전사 텍스트는 보지 않으므로 중간 발화를 건드릴 수 없다.
  # mean을 쓰는 이유: 실제 무음 녹음에도 순간 잡음(클릭·숨소리·책상 두드림)이 있어 피크(max)는
  # 정상 발화와 겹친다(무음 녹음의 max가 정상 회의 피크와 구분이 안 됨). 평균은 순간 잡음에
  # 거의 움직이지 않아 견고하다.
  # 임계 -50dB: 정상 회의 평균은 대략 -25~-45dB, 실제 무음 녹음은 -60dB 안팎이라 그 사이를
  # 가른다. 평균은 시간 적분이라 긴 무음 중 짧은 발화(희소 발화)도 그 구간이 평균을 끌어올려
  # 보호된다(0.1% 미만 발화여야 -50 아래로 떨어짐).
  # 결과는 transcribe_result.json에 기록하고 frontend가 읽어 diarize·회의록을 건너뛴다.
  # fail-open: 측정 실패 시 발화 있음으로 간주 (정상 녹음을 버리지 않는 쪽으로 안전).
  local result_file="$session_dir/transcribe_result.json"
  local mean_vol
  mean_vol=$("$ffmpeg" -i "$wav_file" -af volumedetect -f null /dev/null 2>&1 \
    | awk -F': ' '/mean_volume/ {gsub(/ dB/, "", $2); print $2; exit}')
  local no_speech="false"
  if [[ -n "$mean_vol" ]] && awk -v v="$mean_vol" 'BEGIN { exit !(v < -50) }'; then
    no_speech="true"
  fi
  printf '{\n  "no_speech": %s,\n  "mean_volume": "%s"\n}\n' \
    "$no_speech" "${mean_vol:-unknown}" > "$result_file"
  if [[ "$no_speech" == "true" ]]; then
    warn "녹음된 발화가 감지되지 않았습니다 (평균 ${mean_vol}dB)"
  fi

  ok "전사 완료"
}
