# Junmit

회의 녹음을 전사하고, 화자를 분리하고, 회의록을 작성하는 도구입니다. 회의록은 유형별 가이드(`presentation`/`note`/`review` 또는 사용자 정의)에 따라 자동 작성되며, `auto` 모드에선 회의 내용을 보고 적합한 유형을 자동 판단합니다. 기본 3유형 외에 사용자가 자기 팀/조직에 맞춰 새 유형을 추가할 수 있습니다.

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
  - `resources/bin/` — 빌드된 sidecar 바이너리 + 동봉 (whisper-cli, diarize, whisper-parse, libNative.dylib, uv 등). gitignored
  - `resources/models/` — 앱 동봉 ML 모델 (pyannote 화자분리, CC-BY-4.0 — `build-binaries.sh`가 배치). gitignored. 덕분에 사용자는 HF 계정·토큰·게이트 동의가 불필요
  - `resources/install.sh` — 사용자 setup 진입점 (앱이 Setup 화면에서 실행)
  - `resources/vocabulary.json` — 용어 사전 **시드**. 첫 실행 시 `~/Library/Application Support/app.junmit/vocabulary.json`으로 복사된다 (사용자 영역, 단일 진실 원천). 앱의 "용어 사전" 화면에서 등록/수정/삭제하며 whisper `--prompt` priming + 후보정 교정이 함께 읽는다. `{ "terms": [...] }` 객체 래퍼 (추후 형제 필드 확장 여지)
  - `resources/templates/` — 회의 유형별 작성 가이드 시드. 첫 실행 시 `~/Library/Application Support/app.junmit/templates/`로 복사된다 (사용자 영역, 단일 진실 원천)
  - `resources/.claude/skills/` — LLM 워크플로우 스킬
    - `meeting/SKILL.md` — 회의록 작성 (전사 교정·화자 식별·회의록 초안. 5단계 자동 처리)
    - `meeting/notes-rules.md` — 회의록 작성 공통 규칙 (자동 판단·품질 경고·sentinel·action items·결론 태그·free-form)
    - `publish/SKILL.md` — Confluence 등록 (publish.json 기반 결정론적 + ADF 변환)
    - `assist/SKILL.md` — 회의록 작성 후 사용자 자유 추가 요청 (AskUserQuestion으로 의도 파악 + 회의록 직접 수정)
    - `template/SKILL.md` — 회의 유형 가이드 생성/조정 (앱 "회의 유형" 화면에서 진입. 자연어로 새 유형 생성·AI 대화로 조정. 입력은 `templates/.staging/request.json`, 결과는 `.staging/result.md`에 쓰고 `app_template_ready` 신호 → 앱 미리보기. `/assist`처럼 PTY 유지하며 대화로 다듬음)
  - `resources/.claude/CLAUDE.md` — 스킬 실행 시 사용자 친화 출력 규칙 (PTY cwd 기준 자동 로드. release 환경에서 IDE 컨텍스트로 새지 않음)

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
| `recording.wav` | 녹음 (whisper 입력, 16k mono). 시스템 오디오 캡처 시 마이크↔시스템 RMS 상관으로 자동 분기: 헤드폰(에코 없음)=마이크+시스템 오프라인 믹스 / 스피커(원격이 마이크에 에코로 재유입)=마이크 단독(더블링·울림 회피). 분리트랙은 기본 미보존(`keep_stems` 센티넬 시 진단용 보존) |
| `recording.flac` | 압축 보관용 |
| `segments.json` | whisper 전사 세그먼트 (무음·크레딧 환각 필터 적용) |
| `diarize.json` | 화자분리 결과 |
| `transcript.txt` | 원본 전사본 ([SPEAKER_XX M:SS] text 형식) |
| `transcript_corrected.txt` | 교정된 전사본 (LLM 문맥 교정) |
| `meeting.json` | 회의 메타데이터 단일 진실 원천 — `title`, `date`, `time?`, `type`, `attendees`, `agenda`, `source`, `detailed_correction`(정밀 교정 토글. **기본 ON=정밀**, 녹음 시작 설정에서 opt-out 가능. true/없음=Phase-1이 전사 텍스트 교정까지, false=생략), `capture_mode`(`mic`/`mic+system`. 시스템 오디오는 항상 캡처를 시도(OS 권한이 게이트)하고, convert가 실제 캡처 결과를 기록. 부재=옛 세션·마이크만) |
| `notes.json` | 녹음 중 사용자 메모 (없을 수 있음). `notes` 배열 — `{ t(경과 초), kind }`. `kind`: `speaker`(+`speaker` 이름, 화자 힌트) / `text`(+`text`, 자유 메모). `/meeting`이 화자 매핑·회의록 작성에 활용 |
| `meeting-notes.md` | 회의록 본문 (SPEAKER_XX 라벨 포함, LLM·사용자 공통 편집. 앱이 표시 시점에만 이름 치환) |
| `speaker_mapping.json` | 화자 이름 매핑 (사용자 수정 가능, 단일 진실 원천) |
| `publish.json` | 발행 설정·결과 (사용자 입력 + LLM 결과). `confluence.mode` (create/append/skip), `parentUrl`, `pageUrl`, `published` |

## 워크플로우

### 1. `/meeting {session_dir}` — 회의록 작성
1. 화자 라벨 교정 + 화자 매핑 (transcript.txt → transcript_corrected.txt). **정밀 교정(기본; `detailed_correction`이 false가 아니면)이면 전사 텍스트 교정(text-correction)도 병렬 수행** — 사용자가 끈 빠른 경로(`false`)는 생략하고 회의록 작성자가 vocab·attendees로 자체 교정
2. 화자 식별 + 회의 내용 파악
3. 회의 유형 결정 (`meeting.json`의 `type` 필드. `auto`이면 사용자 templates 디렉토리의 frontmatter `summary` 매칭, 어디에도 안 맞으면 free-form)
4. 회의록 작성 (`~/Library/Application Support/app.junmit/templates/{type}.md` + `notes-rules.md` 적용)
5. 완료 신호 (`app_phase_done`) — 앱 review 화면 전환, PTY 살림 (사용자 추가 요청 가능)

### 2. 사용자 검토 + 발행 설정
- 회의록 탭에서 본문 검토 + 화자 매핑 검증
- 발행 탭에서 `publish.json` 입력 (mode 라디오 + parentUrl)

### 3. `/publish {session_dir}` — Confluence 등록
- `publish.json` 기반 결정론적 동작 (사용자 입력 안 받음)
- mode `create`만 LLM 호출. `append`(클립보드 복사)·`skip`(건너뛰기)은 frontend가 직접 처리
- SPEAKER_XX 치환 → ADF 변환 → `createConfluencePage` MCP → `publish.json.pageUrl`/`published` 갱신
- 완료 신호 (`app_phase_done`)

### 4. (옵션) Jira 티켓 생성
- 추후 PR에서 `publish.json.jira` 필드 + `publish` 스킬에 Jira 단계 추가 예정

## 참고

- **모든 출력과 대화는 한국어로 진행**
- **스킬 실행 시 적용되는 공통 규칙은 [resources/.claude/CLAUDE.md](resources/.claude/CLAUDE.md) 참고** — 사용자 친화 출력 규칙(영문 용어 금지·TodoWrite 진행 표시·sub-agent 묶음 등). 이 파일은 앱 번들에도 동봉되어 release 환경에서 PTY가 자동 로드함
- 전사본의 SPEAKER_XX 라벨은 자동 화자분리 결과이며 부정확할 수 있음
- 참석자 이름은 자유 형식(영문·한글·풀네임 가능). 캘린더 참석자는 **이메일을 안정 식별자**로 삼아 표시 이름을 해결한다: ① 사용자 매핑 캐시(`~/Library/Application Support/app.junmit/attendee_names.json`, `{ "email": "name" }`) → ② EKParticipant.name(이메일꼴이 아니면) → ③ 이메일 local-part 휴리스틱(`. _ -` 분리·capitalize, 예: `bobs.kim@x.com` → `Bobs`) → ④ 이메일 그대로. MeetingSelector에서 이름을 인라인 편집하면 이메일에 귀속돼 다음 회의부터 자동 적용된다(EventKit displayName은 Google Workspace에서 이메일로 fallback되므로 신뢰하지 않음). Confluence `@mention`은 Atlassian 계정명과 일치하는 이름일수록 잘 해석되고, 안 맞으면 평문으로 graceful fallback
- 회의 유형 가이드는 팀-중립으로 작성됩니다. 자기 팀/조직 컨텍스트(특정 Confluence space, 페이지 패턴, 결정사항 보고서 등)는 사용자 정의 유형을 추가해 가이드 본문에 적으세요.
- **유형 가이드 위치**: `~/Library/Application Support/app.junmit/templates/{name}.md` (단일 진실 원천). 첫 실행 시 `resources/templates/`의 시드(presentation/note/review)가 자동 복사됨. frontmatter는 `name`, `label`, `description`, `summary` 필드 사용 (`label`/`description`은 UI 버튼 표시용, `summary`는 multi-line block + auto 매칭 핵심). 본문엔 `## 예시 회의록`(샘플) 섹션 포함.
- **유형 관리는 앱 "회의 유형" 화면**(마스터-디테일: 목록 → 상세): ① 자연어로 새 유형 **생성**(`/template` 스킬) ② 기존 유형을 AI 대화로 **조정** ③ 가이드 원문 **직접 편집** ④ 삭제. 저장 시 Rust 게이트(`cmd_commit_meeting_type`/`cmd_save_meeting_type`)가 frontmatter·예시 형식·slug·중복을 검증. 직접 파일 편집도 여전히 유효(단일 진실 원천). 삭제한 유형으로 작성됐던 과거 회의 재작성 시엔 `/meeting`이 free-form으로 graceful fallback.
