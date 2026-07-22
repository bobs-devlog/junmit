# Junmit

회의 녹음을 전사하고, 화자를 분리하고, 회의록을 작성하는 도구입니다. 회의록은 유형별 가이드(`presentation`/`note`/`review`/`retrospective`/`1on1` 또는 사용자 정의)에 따라 자동 작성되며, `auto` 모드에선 회의 내용을 보고 적합한 유형을 자동 판단합니다. 기본 5유형 외에 사용자가 자기 팀/조직에 맞춰 새 유형을 추가할 수 있습니다.

## 프로젝트 구조

- `src/`, `src-tauri/` — Tauri 앱 (프론트엔드 + Rust 백엔드). 사용자가 실제로 쓰는 진입점
- `swift-cli/` — Swift sidecar 소스 + 메인 앱에 link되는 dylib 소스 (모두 SwiftPM 패키지)
  - `diarize/` — transcript 병합 + whisper 파싱 SwiftPM 패키지. `diarize`, `whisper-parse` 등 바이너리 빌드
  - `system/` — EventKit/AVFoundation/CoreAudio 호출용 dynamic library (`libNative.dylib`). 별도 sidecar 프로세스가 아닌 메인 앱에 link되어야 TCC가 app.junmit bundle identity로 권한을 귀속함. `SystemAudioCapture.swift`는 원격회의 시스템 오디오를 CoreAudio Process Tap으로 캡처(macOS 14.4+ 필요 — 그래서 앱 최소 버전이 14.4). 권한은 공개 조회 API가 없어 private TCC SPI(`kTCCServiceAudioCapture`, 비-App Store 가용)로 조회·요청
- `scripts/` — 개발자가 직접 돌리는 빌드/배포 도구 (`build-binaries.sh`, `release.sh`)
- `output/` — 세션별 결과물 디렉토리
- `resources/` — 앱 동봉 자산 (release 시 `.app/Contents/Resources/`로 복사, dev에선 PTY cwd가 여기). IDE Claude Code의 워크스페이스 root와 분리하기 위한 의도적 배치
  - `resources/lib/` — 앱이 런타임에 호출하는 스크립트
    - `transcribe.sh`, `diarize.sh` — 전사/화자분리 파이프라인. 앱이 `bash`로 source해서 호출
    - `signal.sh` — macOS 알림/Tauri 신호 유틸 (`bash -c`로 호출)
    - `pyannote_diarize.py` — pyannote.audio 화자분리 실행 스크립트 (MPS GPU 가속)
    - `local_meeting.py`, `local_rules.md` — 로컬 LLM 회의록 백엔드 (active_cli=`mlx`, AI 구독 없는 사용자용). Gemma 4 12B(Apache 2.0, mlx-vlm) 2종 — 표준(순수 4bit 6.8GB, 16GB Mac)/고품질(혼합 정밀도 11GB, 24GB+), 선택은 `~/Library/Application Support/app.junmit/local_model` 파일(Rust `cmd_set_local_model`이 기록, install.sh·python이 읽음). 파이프라인: 유형 자동 분류(auto 시) → 화자 매핑 준비(기존 매핑 보존 + 녹음 힌트 결정론 — LLM 제안은 실측 채택 0으로 제거, 팝오버 "AI 힌트"는 에이전트 CLI(claude/codex/antigravity) 경로 전용) → 초안(교정본 우선, 9k 토큰 초과 시 map-reduce, 사용자 메모 앵커) → 자기검증(전사 대조로 시제·상태·누락 교정) → 결정론 후처리(헤더 주입·라벨/추측 병기 정리). 에이전트 아님 — MCP·assist 불가라 프론트가 게이팅(`cliHasAgent`). **실행은 PTY가 아니라 Rust `cmd_run_local_meeting`**(전사·화자분리와 같은 일반 서브프로세스 — stdout을 `local:output` 이벤트로 스트리밍해 진행 패널(LocalProgressPanel)에 표시, 완료/실패는 신호 파일 → app:signal). 모델 실측 근거는 memory `project_local_llm_spike` 참고
  - `resources/bin/` — 빌드된 sidecar 바이너리 + 동봉 (whisper-cli, diarize, whisper-parse, libNative.dylib, uv 등). gitignored
  - `resources/models/` — 앱 동봉 ML 모델 (pyannote 화자분리, CC-BY-4.0 — `build-binaries.sh`가 배치). gitignored. 덕분에 사용자는 HF 계정·토큰·게이트 동의가 불필요
  - `resources/install.sh` — 사용자 setup 진입점 (앱이 Setup 화면에서 실행)
  - `resources/vocabulary.json` — 용어 사전 **시드**. 첫 실행 시 `~/Library/Application Support/app.junmit/vocabulary.json`으로 복사된다 (사용자 영역, 단일 진실 원천). 앱의 "용어 사전" 화면에서 등록/수정/삭제하며 whisper `--prompt` priming + 후보정 교정이 함께 읽는다. `{ "terms": [...] }` 객체 래퍼 (추후 형제 필드 확장 여지)
  - `resources/templates/` — 회의 유형별 작성 가이드 시드. 첫 실행 시 `~/Library/Application Support/app.junmit/templates/`로 복사된다 (사용자 영역, 단일 진실 원천)
  - `resources/.claude/skills/` — LLM 워크플로우 스킬
    - `meeting/SKILL.md` — 회의록 작성 (전사 교정·화자 식별·회의록 초안. 5단계 자동 처리)
    - `meeting/notes-rules.md` — 회의록 작성 공통 규칙 (자동 판단·품질 경고·sentinel·action items·결론 태그·free-form)
    - `assist/SKILL.md` — 회의록 작성 후 사용자 자유 추가 요청 (AskUserQuestion으로 의도 파악 + 회의록 직접 수정)
    - `template/SKILL.md` — 회의 유형 가이드 생성/조정 (앱 "회의 유형" 화면에서 진입. 자연어로 새 유형 생성·AI 대화로 조정. 입력은 `templates/.staging/request.json`, 결과는 `.staging/result.md`에 쓰고 `app_template_ready` 신호 → 앱 미리보기. `/assist`처럼 PTY 유지하며 대화로 다듬음)
  - `resources/.claude/CLAUDE.md` — 스킬 실행 시 사용자 친화 출력 규칙 + 세션 파일 수정 공통 규칙(수정 후 `app_refresh`·대규모 수정 전 백업) (PTY cwd 기준 자동 로드. release 환경에서 IDE 컨텍스트로 새지 않음)

### 디렉토리 정책 (새 파일 추가 시)

각 디렉토리 한 줄 정의:

- `swift-cli/` = "빌드되어 `resources/bin/`에 들어가는 Swift sidecar 소스 + 메인 앱에 link되는 dylib 소스 (TCC 권한이 메인 앱 identity로 귀속되어야 하는 경우)"
- `scripts/` = "개발자가 직접 돌리는 빌드/배포 도구"
- `resources/` = "앱 동봉 자산. PTY cwd가 여기. release 시 번들 Resources/로 복사. IDE Claude Code와 자동 분리되는 자산 격리 영역"
- `resources/lib/` = "앱이 실행 중에 호출하는 스크립트 (bash 오케스트레이션 + Python ML)"
- `resources/bin/` = "빌드 산출물 + 동봉 바이너리"
- `resources/models/` = "앱 동봉 ML 모델 (build-binaries.sh가 배치)"

언어 선택: ML/외부 Python 라이브러리 의존(pyannote 등)은 Python(`resources/lib/*.py`), macOS 네이티브 API와 텍스트 처리·CLI 도구는 Swift(`swift-cli/`), 외부 명령 오케스트레이션은 bash(`resources/lib/*.sh`). Python 의존은 ML 영역에 한정.

## 세션 디렉토리 구조

각 회의는 `output/{timestamp}_{title}/` 디렉토리에 저장됩니다:

| 파일 | 설명 |
|------|------|
| `recording.wav` | 녹음 (whisper 입력, 16k mono). 시스템 오디오 캡처 시 마이크↔시스템 RMS 상관으로 자동 분기: 헤드폰(에코 없음)=마이크+시스템 오프라인 믹스 / 스피커(원격이 마이크에 에코로 재유입)=마이크 단독(더블링·울림 회피). **회의 원본 오디오는 민감하므로 화자분리 완료 후 기본 자동 삭제**(전사·화자분리만 오디오를 쓰고 `/meeting`은 텍스트만 씀; Granola식 프라이버시 기본). 숨은 개발자 플래그 `keep_recording` 센티넬(`~/Library/Application Support/app.junmit/keep_recording`, 존재만 체크)이 있으면 보존 — recording.wav 유지 + 분리트랙(스템)도 진단용 보존(재처리·믹스 진단·AEC 실험용, UI 없음, dev/release 동일) |
| `segments.json` | whisper 전사 세그먼트 (무음·크레딧 환각 필터 적용) |
| `diarize.json` | 화자분리 결과 |
| `transcript.txt` | 원본 전사본 ([SPEAKER_XX M:SS] text 형식) |
| `transcript_corrected.txt` | 교정된 전사본 (LLM 문맥 교정) |
| `meeting.json` | 회의 메타데이터 단일 진실 원천 — `title`, `date`, `time?`, `type`, `attendees`, `agenda`, `source`, `ai_polish`(AI 다듬기 토글 — **기본 ON**, 녹음 시작 설정에서 opt-out 가능. 스킬 분기와 표시(사이드바 stepper·기록 카드)가 이 값 하나를 공유하므로, 표시는 현재 선택된 백엔드를 절대 섞지 않는다(`constants.visibleSteps`). true/없음=1단계 sub-agent 3개(화자 라벨 교정·화자 매핑·전사 텍스트 교정) 수행, false=**1단계 전체 생략** — 원본 전사로 바로 작성(시간·토큰 절약, 화자 귀속 품질 하락. 화자 힌트는 메인이 인라인 반영, corrected.txt 미생성). **로컬 AI(mlx)는 이 단계가 없어 작성 완료 시 false로 갱신된다**(`phase_done`의 mlx 분기. 시작이 아니라 완료인 이유 — 중단·실패한 실행이 false를 남기면 백엔드를 바꿔 다시 작성할 때 스킬이 그걸 지시로 읽어 1단계를 통째로 건너뛴다. 실행 중 사이드바 표시는 파일이 아니라 "지금 도는 작업의 주체"로 판단해 이 지연을 메운다 — `SessionScreen.polishInThisRun`). 녹음 시작 토글은 한 번 지나가면 끝이라 **되살리는 지점은 재작성 다이얼로그의 "AI 다듬기 포함" 체크박스**뿐(에이전트 CLI + 교정본 없음일 때만 노출 — 교정본이 있으면 재작성이 그걸 재사용할 뿐 1단계를 다시 돌리지 않아, 켜도 아무 일이 없고 꺼도 교정본은 계속 쓰이면서 표시만 어긋난다)), `notes_verification`(회의록 검증 토글 — UI "회의록 검증", **기본 ON**. false=자기검증 단계 생략, 속도/토큰 우선 사용자용. 에이전트 경로 전용. 회의록을 쓰는 일의 마지막 단계라 재작성도 이 값을 그대로 따른다(별도로 묻지 않음). 두 토글은 녹음 시작 설정의 "시간·토큰 절약" 섹션), `capture_mode`(`mic`/`mic+system`. 시스템 오디오는 항상 캡처를 시도(OS 권한이 게이트)하고, convert가 실제 캡처 결과를 기록. 부재=옛 세션·마이크만) |
| `notes.json` | 녹음 중 사용자 메모 (없을 수 있음). `notes` 배열 — `{ t(경과 초), kind }`. `kind`: `speaker`(+`speaker` 이름, 화자 힌트) / `text`(+`text`, 자유 메모). `/meeting`이 화자 매핑·회의록 작성에 활용하고, 전사본 탭도 읽기 전용으로 표시(자유 메모는 앵커 발화 줄 뒤 행, 화자 힌트는 발화 줄 칩 옆 🎙 마커 — 배치 규칙은 `src/utils/recordingNotes.ts` `buildNotePlacement`) |
| `meeting-notes.md` | 회의록 본문 (SPEAKER_XX 라벨 포함, LLM·사용자 공통 편집. 앱이 표시 시점에만 이름 치환) |
| `speaker_mapping.json` | 화자 이름 매핑 (사용자 수정 가능, 단일 진실 원천) |
| `headless.jsonl` | headless 실행 시에만 — 스트림 JSONL 원문(claude `-p` stream-json / codex `exec --json`. 진단용. pipeline.log엔 최종 판정·stderr 요약만) |
| `agent_session.json` | headless 실행 시에만 — 작성 대화 식별 `{cli, session_id}`. `/assist`가 이어가기(claude `--resume` / codex `resume`)로 작성 대화 맥락을 이어가는 재료(무효 id로 즉시 종료 시 앱이 비움, 현재 CLI와 다르면 무시 → fresh 폴백) |

## 워크플로우

### 1. `/meeting {session_dir}` — 회의록 작성

> **headless 실행:** claude·codex의 `/meeting`은 PTY 대신 Rust `cmd_run_headless_meeting`(claude=`claude -p "/meeting" --output-format stream-json --verbose --permission-mode bypassPermissions` / codex=`codex exec --json --skip-git-repo-check --sandbox workspace-write --add-dir <app_data_dir> "Run the meeting skill."`, 일반 서브프로세스·stdin 닫음)으로 실행. 진행은 `headless:event` → AgentProgressPanel(앱 상태 기반 결정론 상태 라인 + sub-agent·결과 요약의 평평한 로그 — 모델 출력에서 단계를 추론하지 않음, 파서는 `src/utils/headless.ts` 단일 지점이 두 스키마를 모두 해석). **codex 스트림은 sub-agent 시작(spawn)을 노출하지 않아**(0.144.5 실측, exec JSONL 변환기의 SubAgentActivity 미매핑) per-agent 행 없이 요약 텍스트만 — collab wait 이벤트는 상태 카드 전환 신호로만 사용. 완료/실패 신호·검증 잠금·알림은 신호 파일 경로 그대로. `/assist`는 **입력 선행** — 앱 입력 폼(사이드바·패널 빈 상태)에서 요청을 먼저 받아 실어 보낸다: 살아있는 PTY면 stdin(스킬 트리거는 PTY 대화당 최초 1회만 — 재트리거 시 재인사 중복), 없으면 보존된 `{cli, session_id}`로 이어가기 PTY 재진입(claude `--resume` / codex `resume` — 대화 맥락 유지)하며 초기 프롬프트에 요청 병기. 사용자 자유 텍스트가 `bash -c` 명령줄에 실리므로 spawn 경로는 single-quote 이스케이프(`spawn.ts shellQuote`) 필수. **antigravity는 PTY 유지** — 1.1.4에 `-p`가 생겼지만 이벤트 스트림 부재(진행 패널에 넣을 게 없고 하트비트조차 불가)·headless 권한 soft-deny·격리 홈 부재로 headless 열세 확정(재검토는 agy가 JSON 스트림을 얻을 때).
1. 화자 라벨 교정 + 화자 매핑 + 전사 텍스트 교정 (transcript.txt → transcript_corrected.txt, sub-agent 3개 병렬) — 모든 sub-agent를 기다려 교정 완성본을 만든 뒤 진행. 완료 시점부터 앱이 화자 매핑 편집 허용. **AI 다듬기 OFF(`ai_polish: false`)면 이 단계 전체를 건너뜀** — sub-agent 0개, 화자 힌트(notes.json)만 메인이 speaker_mapping.json에 반영 후 `correct` 신호 즉시 전송, 이후 원본 transcript.txt로 작성 (진행 패널 분모도 2+다듬기+검증=2~4로 감소, 앱은 매핑 없는 라벨을 "참석자 N"으로 폴백 표시)
2. 화자 식별 + 회의 내용 파악
3. 회의 유형 결정 (`meeting.json`의 `type` 필드. `auto`이면 1단계에서 분류 sub-agent가 병렬로 결정, 어디에도 안 맞으면 free-form)
4. 회의록 작성 (`~/Library/Application Support/app.junmit/templates/{type}.md` + `notes-rules.md` 적용)
5. 완료 신호 (`app_phase_done`) — 회의록 **즉시 공개**(검증 대기 안 함 — 탭 열람 가능). 단 **회의록 탭 자동 이동·완성 배너·"AI에게 추가 요청" 버튼은 검증 종료 시점**(사용자는 그동안 전사본 탭에서 화자 매핑 계속, 검증 OFF·mlx는 즉시. 추가 요청을 검증 중에 열면 headless에선 resume 스폰이 검증 프로세스와 세션 파일을 동시에 쓰는 경합 — 그래서 노출도 verify 이후). PTY 살림 (사용자 추가 요청 가능)
6. 회의록 자기검증 (`notes-verification` sub-agent 2개 병렬 — 귀속·수치 / 블록 누락 분담, 전사 대조 보고 → 메인 적용 → `notes_verification_report.json` + `app_phase_step_done verify` **항상** 전송). 공개 후 사후 다듬기 — 검증 동안 앱은 회의록 편집·유형 변경·AI 추가 요청을 잠그고 **헤더·사이드바를 "검증 중"으로 표시**(완료 띠·회의록 step ✓는 verify 신호 후에만 — 미리 "완료"로 보이면 진행 중 인지 불가. verify 신호로 해제, 신호 유실 시 10분 타임아웃·PTY 종료가 회수) 완료 시 **회의록 탭만 재로드**(전사본 탭 불간섭 — 공개 직후의 화자 매핑 작업 보존), 바뀐 내역은 "검증 N건" 칩으로 노출. `meeting.json.notes_verification: false`(UI "회의록 검증" 토글, 기본 ON)면 생략하며 앱도 잠그지 않음(로컬 파이프라인의 내장 자기검증과 무관, 에이전트 경로 전용). 재작성 시 이전 영수증은 자동 제거(Rust `backup_meeting_notes` + 스킬 4단계 정리). **끝나면 macOS 알림(검증 ON/OFF 공통, 항상 마지막)** — 알림으로 복귀한 사용자가 검증까지 끝난 완성본을 보게

> **실측 기록 (2026-07-11~12, 재논의 방지):** 전사 텍스트 교정은 회의록 품질에 기여하지 않음(5세션 A/B — 오타 유입 0·내용 정확도 무관, 가치는 전사본 열람·화자 매칭). 화자 매핑은 대화형 회의 품질에 실질 기여(매핑 없는 작성은 귀속 왜곡). 교정 background 분리를 구현·검증까지 했으나 **단순한 선형 서사(유지보수·사용자 이해) 우선으로 동기 회귀** — 비동기 재제안은 그 비용을 뒤집는 새 근거가 있을 때만.

### 2. 사용자 검토
- 회의록 탭에서 본문 검토 + 화자 매핑 검증. 필요 시 탭 툴바 "복사"로 클립보드 복사(리치텍스트).

## 참고

- **모든 출력과 대화는 한국어로 진행**
- **스킬 실행 시 적용되는 공통 규칙은 [resources/.claude/CLAUDE.md](resources/.claude/CLAUDE.md) 참고** — 사용자 친화 출력 규칙(영문 용어 금지·TodoWrite 진행 표시·sub-agent 묶음 등) + 세션 파일 수정 공통 규칙(phase 신호 없는 수정 후 `app_refresh` 필수·대규모 수정 전 백업). 이 파일은 앱 번들에도 동봉되어 release 환경에서 PTY가 자동 로드함
- 전사본의 SPEAKER_XX 라벨은 자동 화자분리 결과이며 부정확할 수 있음
- 참석자 이름은 자유 형식(영문·한글·풀네임 가능). 캘린더 참석자는 **이메일을 안정 식별자**로 삼아 표시 이름을 해결한다: ① 사용자 매핑 캐시(`~/Library/Application Support/app.junmit/attendee_names.json`, `{ "email": "name" }`) → ② EKParticipant.name(이메일꼴이 아니면) → ③ 이메일 local-part 휴리스틱(`. _ -` 분리·capitalize, 예: `bobs.kim@x.com` → `Bobs`) → ④ 이메일 그대로. MeetingSelector에서 이름을 인라인 편집하면 이메일에 귀속돼 다음 회의부터 자동 적용된다(EventKit displayName은 Google Workspace에서 이메일로 fallback되므로 신뢰하지 않음)
- 회의 유형 가이드는 팀-중립으로 작성됩니다. 자기 팀/조직 컨텍스트(페이지 패턴, 결정사항 보고서 등)는 사용자 정의 유형을 추가해 가이드 본문에 적으세요.
- **유형 가이드 위치**: `~/Library/Application Support/app.junmit/templates/{name}.md` (단일 진실 원천). 매 실행 시 `resources/templates/`의 시드(presentation/note/review/retrospective/1on1) 중 사용자 위치에 **없는 파일만** 자동 복사됨 — 신규 시드는 기존 사용자에게도 전파되지만, 이미 복사된 파일은 시드가 개정돼도 갱신되지 않음. 사용자가 삭제한 유형은 tombstone(`templates/.deleted_types.json`)에 기록되어 재복사에서 제외됨(삭제는 영구). frontmatter는 `name`, `label`, `description`, `summary` 필드 사용 (`label`/`description`은 UI 버튼 표시용, `summary`는 multi-line block + auto 매칭 핵심). 선택 필드 `title_keywords`(쉼표 구분, 단일 라인) — 유형 자동 판별의 0순위 신호로 **로컬·에이전트 두 경로가 공유**한다: 회의 **제목**이 정확히 한 유형의 키워드와 매칭되면 그 유형으로 확정(로컬은 결정론 코드 `keyword_type`, 에이전트는 분류 sub-agent·notes-rules 동일 규칙 — 백엔드 간 유형 일관성), 복수/무매칭이면 내용 기반 판단 폴백. 키워드는 코드가 아니라 각 가이드가 소유 — 커스텀 유형도 선언하면 참여. 본문엔 `## 예시 회의록`(샘플) 섹션 포함.
- **유형 관리는 앱 "회의 유형" 화면**(마스터-디테일: 목록 → 상세): ① 자연어로 새 유형 **생성**(`/template` 스킬) ② 기존 유형을 AI 대화로 **조정** ③ 가이드 원문 **직접 편집** ④ 삭제. 저장 시 Rust 게이트(`cmd_commit_meeting_type`/`cmd_save_meeting_type`)가 frontmatter·예시 형식·slug·중복을 검증. 직접 파일 편집도 여전히 유효(단일 진실 원천). 삭제한 유형으로 작성됐던 과거 회의 재작성 시엔 `/meeting`이 free-form으로 graceful fallback.
