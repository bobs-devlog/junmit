---
name: meeting
description: 회의 녹음 전사본을 분석하여 화자를 식별하고 회의록을 작성합니다.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read Write Edit Bash Grep
---

# 회의록 작성 워크플로우

**세션 디렉토리는 `$APP_SESSION_DIR` 환경변수로 전달됩니다** (앱이 PTY spawn 시 설정).
$ARGUMENTS는 사용하지 않음 — claude code 슬래시 커맨드 파서가 quote를 처리하지 않아 공백이
포함된 macOS 경로(`Application Support` 등)를 인자로 안전하게 전달할 수 없기 때문.
산문 placeholder도 일관성을 위해 `$SESSION_DIR` 사용 (notes-rules.md, templates 포함).

작업 시작 시 sessionDir을 변수로 잡아 사용:

```bash
SESSION_DIR="$APP_SESSION_DIR"
```

> **스크립트·바이너리는 `$APP_DIR`(이 세션이 시작된 작업 루트 — `lib/`·`bin/`이 여기 있음)에 있습니다.** 호출은 항상 `$APP_DIR/lib/…`·`$APP_DIR/bin/…` 절대경로로 하고 **절대 `cd` 하지 마세요.** 하네스가 "Base directory: …/skills/…"를 안내해도 스크립트는 거기 없습니다(스킬 폴더엔 문서만 있고 `lib/`·`bin/`은 없습니다). 특히 신호(`signal.sh`)는 앱 UI 전진의 **필수**라, `No such file`이 떠도 그건 경로/디렉토리 오류이지 생략 사유가 **아닙니다** — 신호를 임의로 건너뛰거나 "사용 불가"로 처리하지 마세요.

이 스킬은 transcript 교정·화자 식별·회의록 초안 작성을 자동으로 수행합니다.

**`AskUserQuestion` 사용 금지** — 모든 단계를 자율적으로 수행하세요.

**TodoWrite로 진행 상황 표시** — `SESSION_DIR`을 잡으면 **맨 처음 도구 호출로** 다음 4개 항목 todos를 초기화하세요(`회의 정보 확인`을 `in_progress`로 시작). **`ls`·`cat`·`Read` 등 어떤 파일 확인·읽기보다 먼저** 박스를 띄워, 사용자가 보는 첫 화면이 셸 명령이 아니라 "회의 정보 확인하는 중" 박스가 되게 합니다 — 박스보다 파일 읽기가 먼저 보이면 멈춘 듯·개발자 화면처럼 느껴집니다. **선행 확인·`meeting.json` 읽기는 박스를 띄운 *뒤* "회의 정보 확인" 단계 안에서** 합니다 (그래야 파일 읽기 흔적이 "회의 정보 확인하는 중" 항목 아래 자연스럽게 놓임):

- 정상 흐름에선 앱이 전사·화자분리를 끝낸 뒤 `/meeting`을 부르므로 `transcript.txt`가 **항상 존재** → 박스를 먼저 띄워도 안전합니다.
- "회의 정보 확인" 중 드문 edge 처리: ⓐ `transcript.txt` 없음(전사 미완)이면 아래 "선행 확인"의 에러를 내고 종료 ⓑ `transcript_corrected.txt`·`meeting-notes.bak.*.md` 존재(재작성·재시도)면 "회의 정보 확인"을 `completed`로 마킹하고, 아래 재작성 모드 항목대로 "AI 다듬기"도 즉시 `completed`로 갱신.

이후 각 단계 진입 시 `in_progress`, 완료 시 `completed`로 마킹을 업데이트하세요. 사용자는 이 todos를 터미널 내 `⏺ Update Todos` 박스로 보며 진행 상황을 인지합니다. **공통 작성 규칙(첫 글자부터 한국어·메타 발화 금지·내부 용어 노출 금지·sub-agent 묶음)은 [.claude/CLAUDE.md](../../CLAUDE.md)의 "사용자 친화 출력 규칙" 참고 — 특히 아래 표의 "매핑되는 단계" 컬럼과 본문의 단계 번호·파일명·분기 용어는 전부 내부 지침이라 사용자 출력에 옮기지 마세요.**

| # | content (명사형, 사용자 시점) | activeForm (진행형) | 매핑되는 단계 (내부용 — 사용자 출력 금지) |
|---|---|---|---|
| 1 | 회의 정보 확인 | 회의 정보를 확인하는 중 | 선행 확인(전사 완료·재작성 여부) + `meeting.json` 읽기(정밀 교정 여부·유형) |
| 2 | AI 다듬기 | 회의 내용을 다듬는 중 | 1·2단계 (1단계 병렬 후보정 + 화자 식별/요약 출력. type이 auto면 유형 분류도 이 묶음에서 병렬로 끝남) |
| 3 | 회의록 작성 | 회의록을 작성하는 중 | 3·4단계 (유형 확정·가이드 로드 + 본문 작성) |
| 4 | 마무리 | 마무리하는 중 | 5단계 (신호·알림·요약 출력) |

**"회의 유형 결정"을 별도 todo로 두지 않는다** — type이 `auto`면 유형 분류가 "AI 다듬기"에서 병렬로 끝나고, 명시 유형이면 결정할 게 없다. 3단계가 하는 일(결정 적용 + 가이드 로드)은 거의 즉시라 "회의록 작성" 항목에 흡수한다. (1단계를 skip한 재작성·재시도에서 유형 판단을 인라인으로 할 때도 "회의록 작성" 항목 안에서 처리). **"회의 정보 확인"은 이와 별개** — 전사 완료·재작성 여부·정밀 교정 여부 같은 *선행 판단*이라 작업 시작 직후 실제로 수행하는 단계이고, 박스를 첫 출력으로 만들기 위해 1번 항목으로 둔다.

스킬 특화 사항:
- **재작성 모드** (`transcript_corrected.txt`가 이미 존재해 1단계 sub-agent를 skip하는 케이스, [2단계의 재작성 모드 감지](#2단계-화자-식별--회의-내용-파악) 참고) — "회의 정보 확인"에서 이를 감지하면 "회의 정보 확인"과 "AI 다듬기"를 즉시 `completed`로 마킹하고 "회의록 작성"을 `in_progress`로 시작 (유형 판단이 필요하면 그 안에서 인라인 처리)
- **1단계 sub-agent 병렬 spawn(정밀 3개 / 빠른 2개, type이 auto면 유형 분류까지 +1개)은 "AI 다듬기" todo 한 항목으로 묶음** — 메인이 모든 sub-agent 결과를 받은 뒤 자체 마킹만 업데이트
- 단계별 한국어 요약 출력(`📝 전사 교정 완료 ...`, `🎤 화자 매칭 ...` 등) 기존 형식은 그대로 유지 — TodoWrite는 그 위에 진행 지도를 덧붙이는 역할. **이 이모지 요약 줄 외에 "작업을 시작합니다"류 메타 산문은 출력하지 않습니다** (진행은 TodoWrite가 전담)

---

## 📁 파일별 편집 규칙 (매우 중요 — 먼저 읽기)

이 스킬은 두 가지 핵심 정책 위에서 동작합니다:

1. **sidecar 분리** — `transcript_corrected.txt` 같은 결정론적 파일 수정은 모두 `bin/apply-edits` sidecar가 담당. LLM은 JSON에 "어떤 교정을 할지"만 적고, 실제 파일 변경은 절대 직접 하지 않음. (LLM이 Edit으로 직접 수정하면 라인 드리프트로 앱 UI의 line 번호 매칭이 깨짐)
2. **SPEAKER_XX sentinel** — 회의록의 **발화 주체 표기**(발언 헤더, 의견 출처 라벨)는 `SPEAKER_XX` 라벨을 유지하고, 앱이 표시 시점에만 실제 이름으로 치환. 발화 주체 표기에 실제 이름을 박지 않음. 단 **산문 안에 직접 언급된 인물 이름은 자연어 그대로** (sentinel은 자동 화자분리의 불확실성에만 적용, 발화 텍스트에 등장한 이름은 확실한 정보). **그룹핑/메타 표기**(sub-section 헤더, 발표자 줄)와 **Action Items의 `@assignee`**는 별도 분기 — 아래 표 참고

### 파일 일람

세션 디렉토리(`$SESSION_DIR/`)의 파일들과 책임 구분:

| 파일 | 누가 쓰나 | 누가 읽나 | 역할 |
|---|---|---|---|
| `transcript.txt` | whisper (전사 단계) | LLM, sidecar | 원본 전사. **절대 수정 금지** |
| `transcript_corrected.txt` | sidecar | LLM, 앱 UI | 교정 작업본. **LLM 직접 편집 금지 — sidecar로만 수정** |
| `transcript_text_edits.json` | LLM (1단계, **정밀 경로에서만**) | sidecar, 앱 UI | 텍스트 교정 명세. sidecar가 corrected.txt에 적용한 뒤, 이 JSON을 실패 항목 제외하고 재작성 (`time`은 sidecar가 라인 헤더에서 주입). 빠른 경로(정밀 끔)에선 생성되지 않음 |
| `transcript_speaker_edits.json` | LLM (1단계) | sidecar, 앱 UI | 화자 라벨 재할당 명세. sidecar가 corrected.txt에 적용한 뒤, 이 JSON을 실패 항목 제외하고 재작성 |
| `speaker_mapping.json` | LLM, 사용자 (앱 UI) | LLM, 앱 UI | 화자 → 이름 매핑의 **단일 진실 원천** |
| `meeting-notes.md` | LLM (이 스킬), 사용자 (앱 UI) | 앱 UI, 사용자 | 회의록 본문(유일한 본문 파일). SPEAKER_XX 라벨 유지 (앱이 표시 시점에 치환) |
| `meeting.json` | 앱 (녹음 단계), 사용자 (앱 UI), LLM (type 갱신만 — [notes-rules.md](notes-rules.md) "type 갱신 절차") | LLM | 회의 메타데이터 단일 진실 원천. 필드: `title`, `date`, `time?`, `type`, `attendees`, `agenda`, `source` |
| `notes.json` | 앱 (녹음 중 사용자 메모) | speaker-mapping sub-agent, LLM | 녹음 중 사용자 메모. **없을 수 있음**(메모 안 남긴 정상 케이스). `notes` 배열의 각 항목: `{ t(경과 초), kind }`. `kind: "speaker"`(+`speaker`) = 화자 힌트, `"text"`(+`text`) = 자유 메모 |

### 파일 흐름

```
transcript.txt (whisper 산출물, 변경 금지)
       │
       │  ① sub-agent 병렬 spawn (1단계) — 정밀(기본) 3개 / 빠른(detailed_correction:false) 2개
       │     (+ type이 auto/비어있으면 meeting-type-classification 1개 추가)
       │     - speaker-label-correction  → transcript_speaker_edits.json  (항상)
       │     - speaker-mapping           → speaker_mapping.json           (항상)
       │     - text-correction           → transcript_text_edits.json     (정밀에서만)
       │     - meeting-type-classification → 파일 미작성, TYPE_DECISION 보고 (type auto일 때만)
       │
       │  ② cp transcript.txt → transcript_corrected.txt
       │  ③ sidecar speaker 적용 (corrected.txt 변경 + speaker_edits.json에서 실패 edit 자동 제외)
       │  ④ sidecar text 적용 — 정밀에서만 (corrected.txt 변경 + 실패 edit 자동 제외)
       ▼
transcript_corrected.txt (라벨 교정 반영 + 정밀 시 텍스트 교정도) + speaker_mapping.json
       │
       │  ⑤ 회의 유형 결정 + 회의록 작성 (3·4단계) → meeting-notes.md
       ▼
speaker_mapping.json + meeting-notes.md
       │
       │  ⑥ 앱이 표시 시점에 SPEAKER_XX → 실제 이름 치환
       ▼
사용자에게 실제 이름으로 렌더링된 회의록 표시
```

### 왜 이 구조인가

- **결정론적 파일 수정은 sidecar로 분리**: `transcript_corrected.txt`처럼 line 번호가 UI 매칭 키로 쓰이는 파일은 LLM이 직접 Edit하면 빈 줄·라인 합치기 등으로 line이 어긋날 위험이 있음. JSON으로 명세만 적고 sidecar가 in-line 치환만 하도록 강제 → 라인 수 보존 보장
- **단일 본문 파일**: 사용자가 본문을 편집해도 매핑 변경으로 덮어써지지 않음
- **표시 시점 치환**: `SPEAKER_XX`는 sentinel 역할만 하고, 실제 이름은 뷰 레이어(`substituteNames` JS 함수)에서 매핑 적용. 별도 치환 도구·재저장 불필요

### SPEAKER_XX sentinel의 적용 범위 (중요)

`SPEAKER_XX`는 **자동 화자분리의 불확실성을 메우는 sentinel** — "이 발화의 주체가 누구인가"라는 매핑 결정에만 사용됩니다. 발화 텍스트 자체에 등장한 이름(산문 내 직접 언급)은 확실한 정보이므로 자연어 그대로 작성하세요.

| 영역 | 표기 | 예시 |
|---|---|---|
| 발언 헤더 | `SPEAKER_XX` | `**SPEAKER_03**: 검색 결과는...` |
| 의견·발언 출처 라벨 | `SPEAKER_XX` | `검색 정렬 변경 필요 (SPEAKER_03)` |
| Action Items의 `@assignee` | **케이스 분기** (아래 별도 항목) | 1인칭 자기지정: `@SPEAKER_05`, 3인칭 지시: `@Bobs` |
| **그룹핑/메타 표기** (sub-section 헤더, 발표자 줄) | **매핑 확정 시 자연어, 미확정 시 케이스별** | 아래 별도 항목 참고 |
| **참석자 섹션** (`meeting.json.attendees` 기준) | 평문 이름. 미확인 SPEAKER는 추가 X | `- 참석자: Bobs, Charlie` ([notes-rules.md](notes-rules.md) "참석자 섹션 표기" 참고) |
| **산문 내 인물 언급** | **자연어 (실제 이름)** | "Bobs가 작년에 만든 V1을 베이스로", "A 작업은 Bobs가 진행" |

**그룹핑/메타 표기 처리 규칙** — 발언 단위가 아니라 "한 섹션 전체가 누구의 것인지" 표기하는 영역이라 sentinel 의미가 약함:

| 영역 | 매핑 확정 | 매핑 미확정 |
|---|---|---|
| Sub-section 헤더 (예: 주간 보고의 사람별 sub-section) | `#### Bobs` | `#### SPEAKER_06 (백엔드)` |
| 발표자 줄 (리뷰·발표/세미나) | `- 발표자: Bobs` | `- 발표자: (미확인)` |

- Sub-section은 미매핑 시 SPEAKER 라벨 박아두면 사용자가 매핑 추가했을 때 자동 치환되어 자연스럽게 채워짐
- 발표자 줄은 LLM 추정이 틀릴 수 있어 미확정인 채로 명시적 신호(`(미확인)`)를 주는 게 안전. 사용자가 매핑 + 명확화 후 본문 보정으로 수정
- **진행자 줄은 작성하지 않습니다** — 데일리/위클리에서 진행자는 회의 진행 자체가 정보이지 회의록 본문에 박을 정보는 아님 (호명 멘트도 회의록에서 제외). 매핑 확정 시 자연어 이름은 참석자 섹션의 이름(`Bobs`)으로 충분히 드러남

산문에 박힌 이름은 매핑이 변경돼도 자동 치환되지 않습니다 (의도된 한계). 매핑이 잘못된 채 작성된 회의록은 사용자가 완료 후 '추가 요청'(assist 스킬)으로 본문을 따로 보정.

**Action Items `@assignee` 처리 규칙** — 발화 패턴에 따라 분기:

| 패턴 | 표기 | 예시 발화 → assignee |
|---|---|---|
| **1인칭 자기지정** ("내가/제가 ~ 하겠다") | `@SPEAKER_XX` (발화자 SPEAKER) | "제가 X PRD 작성하겠습니다" → `@SPEAKER_03` |
| **3인칭 명시 지시** ("A는 X가 해주세요" 또는 "X가 ~") | **산문에 명시된 이름 그대로** | "X PRD는 Bobs가 해주세요" → `@Bobs` |
| **역할만 결정 (담당자 미정)** | 역할 자연어 | "백엔드 쪽이 검토 필요" → `@백엔드` |

근거:
- 1인칭 케이스는 발화자 식별 = 담당자 식별이라 발화 주체 표기와 동일 (SPEAKER_XX)
- 3인칭 명시 케이스는 산문에 직접 등장한 이름 = 확실한 정보 (산문 정책과 일관)
- 매핑 변경 시 자연어 이름은 자동 치환되지 않으나 산문 이름과 동일 한계 ('추가 요청'(assist 스킬)으로 보정)

### 금지 사항 (위반 시 매칭이 깨지거나 데이터 손실)

- ❌ `transcript.txt` 원본 수정 (whisper 산출물 보존)
- ❌ `transcript_corrected.txt`를 LLM이 Edit으로 직접 수정 — 반드시 `transcript_*_edits.json` + `bin/apply-edits` 경유
- ❌ 발언 헤더·의견 출처 라벨에 **`참석자A`, `참석자B`** 같은 임시 이름 사용
- ❌ 발언 헤더·의견 출처 라벨에 **실제 이름**(`Bobs` 등) 직접 박기 — `**SPEAKER_XX**:`, `의견 (SPEAKER_XX)` 형식 유지
- ❌ 산문 안에 등장한 인물 이름을 SPEAKER_XX로 강제 치환 (예: "Bobs가 만든 V1" → "SPEAKER_05가 만든 V1") — sentinel은 발화 주체 식별에만 사용
- ❌ **이름(SPEAKER_XX) 병기** (예: "Bobs(SPEAKER_01)에게 요청") — 앱이 표시 시점에 라벨을 이름으로 치환하므로 "Bobs(Bobs)"처럼 깨진다. 산문은 이름만, 출처 라벨은 라벨만
- ❌ 3인칭 명시 지시("Bobs가 해주세요")의 Action Items assignee를 발화자 SPEAKER로 매핑 — 산문에 명시된 이름을 그대로 `@Bobs`로 사용

### 허용/지시 사항

- ✅ transcript 교정은 모두 `transcript_*_edits.json` 작성 후 `bin/apply-edits` 호출로 처리
- ✅ 발화 주체 표기(발언 헤더, 의견 출처 라벨)는 `SPEAKER_XX` 라벨로 저장. Action Items의 `@assignee`는 케이스별 분기 (1인칭 자기지정 → `@SPEAKER_XX`, 3인칭 명시 지시 → 산문 이름 그대로 `@Bobs`)
- ✅ 그룹핑/메타 표기(sub-section 헤더, 발표자 줄)는 매핑 확정 시 자연어, 미확정 시 케이스별 처리 (위 sentinel 적용 표 참고). 진행자 줄은 작성 X
- ✅ 참석자 섹션은 `meeting.json.attendees` 기준으로 작성 — 평문 이름으로 표기. `speaker_mapping`의 미확인 SPEAKER는 참석자 섹션에 추가하지 않음 (발화 분리 오차로 매칭 못 한 화자일 뿐, [notes-rules.md](notes-rules.md) "참석자 섹션 표기" 참고)
- ✅ 산문 내 인물 언급은 **자연어 그대로** 작성. 매핑 변경 시 자동 치환되지 않으므로, 매핑이 바뀐 경우 사용자가 '추가 요청'(assist 스킬)으로 본문 보정
- ✅ 미확인 화자도 `SPEAKER_XX` 라벨 유지. `speaker_mapping.json`의 `name`을 빈 문자열로 두면 UI가 "미확인 (SPEAKER_XX)" 형태로 자연스럽게 표시

---

## 1단계: 화자 라벨 교정 + 화자 매핑 (+ 정밀 시 전사 텍스트 교정) (병렬 sub-agent)

> **이 단계 전체는 내부 분기 판단용 지침입니다.** 아래 등장하는 `정밀 경로`/`빠른 경로`·`detailed_correction`·파일명(`transcript_corrected.txt` 등)·`sub-agent`·단계 번호는 **사용자 출력에 절대 노출하지 마세요** ([.claude/CLAUDE.md](../../CLAUDE.md) "사용자 친화 출력 규칙"). 이 단계에서 사용자에게 내는 텍스트는 "결과 처리"의 한국어 이모지 요약(`🎤 …`, `📝 …`)뿐이며, 그 전에 "분류가 필요한지 확인합니다", "정밀 경로로 진행합니다" 같은 메타 발화를 출력하면 안 됩니다.

화자 작업 sub-agent를 병렬로 spawn해 transcript.txt를 동시에 분석합니다. 각 작업의 출력 영역이 분리돼 있어 병렬 실행이 안전합니다. **정밀 교정이 켜진 회의는 transcript 텍스트 교정(text-correction)까지 함께** 돌립니다.

### 선행 확인

- `$SESSION_DIR/transcript.txt`가 없으면 전사가 완료되지 않은 세션. 다음 메시지 출력 후 즉시 종료:
  ```
  ❌ transcript.txt가 없습니다. 전사 단계를 먼저 완료해주세요.
  ```
- **빈 전사 가드 (필수 — 지어내기 방지)**: `transcript_corrected.txt`(있으면) 또는 `transcript.txt`를 Read해 `[SPEAKER_XX M:SS]` 시각 마커를 뺀 **실제 발화 텍스트**를 확인하세요. 발화 내용이 사실상 없으면(마커만 있고 텍스트가 비었거나 공백뿐, 또는 의미 있는 발화가 몇 글자 수준) — 무음 녹음을 사용자가 escape hatch로 강제 진행한 경우 등 — **회의록을 작성하지 말고** 다음만 수행 후 종료하세요. 전사가 비어 있으면 회의 정보(제목·참석자)만으로 가짜 회의록을 지어내게 되므로, 판단이 애매하면 **작성하지 않는 쪽**을 택합니다:
  1. `$SESSION_DIR/meeting.json`을 Read해 날짜·참석자를 확인
  2. `$SESSION_DIR/meeting-notes.md`를 Write로 아래 플레이스홀더만 작성 (`{날짜}`는 meeting.json의 date, 참석자 줄은 attendees를 평문으로, 빈 배열이면 `- 참석자: -`):
     ```markdown
     - 날짜: {날짜}
     - 참석자: {이름1}, {이름2}, ...

     인식된 발화가 없어 회의록을 작성하지 못했습니다. 녹음에 음성이 제대로 담겼는지 확인해주세요.
     ```
  3. 5단계의 완료 신호(`app_phase_done` + `app_notify`)를 전송하고 종료 — 이후 단계(sub-agent·회의록 작성) 진행 금지. 사용자 출력은 `⚠️ 인식된 발화가 없어 회의록을 작성하지 않았습니다` 한 줄.
- `$SESSION_DIR/transcript_corrected.txt`가 이미 있으면 이 단계를 건너뛰고 2단계로 진행하세요.

### 정밀 교정 여부 확인 (sub-agent 구성을 가름)

**`$SESSION_DIR/meeting.json`을 Read**해 `detailed_correction` 필드를 확인하세요. **`false`면 빠른 경로**(사용자가 정밀 교정을 끔), **그 외(`true` 또는 필드 없음)면 정밀 경로 — 정밀이 기본값**입니다. 이 값이 spawn할 sub-agent 수를 결정하므로 추측하지 말고 반드시 파일을 읽어 판단합니다:

- **정밀 (기본 — `true` 또는 필드 없음)**: 화자 작업 2개 + `text-correction` = **3개** spawn. transcript_corrected.txt의 텍스트 오인식까지 교정해 전사본이 깔끔해집니다.
- **빠른 (`false` — 사용자가 끔)**: 화자 작업 **2개**만 spawn (`speaker-label-correction` + `speaker-mapping`). 전사 텍스트 교정을 생략해 빠르게 진행하고, 회의록 작성 시 작성자가 vocabulary·attendees·문맥으로 자체 교정합니다 (4단계 진입 시 vocab 프리로드).

### 유형 분류 필요 여부 확인 (분류 sub-agent를 가름)

같은 `meeting.json`에서 **`type` 필드**도 확인하세요. `type`이 **`auto`이거나 비어있으면(필드 없음 포함)** 회의 유형을 LLM이 결정해야 하므로, 위 후보정 sub-agent들과 **함께** `meeting-type-classification` sub-agent를 **추가로 병렬 spawn**합니다. 후보정 *후* 직렬로 분류하던 단계를 1단계 병렬 묶음에 합류시켜 wall time(= sub-agent max)에 흡수시키기 위함입니다 (분류는 edit 방출 없는 단일 결정이라 후보정보다 가벼워 max를 넘지 않음).

- **`auto` 또는 비어있음** → 분류 sub-agent **추가** (정밀이면 4개, 빠르면 3개 spawn)
- **`free-form` 또는 명시 유형명**(presentation/note/review/retrospective/1on1/커스텀) → 분류 불필요, 분류 sub-agent **spawn 안 함** (3단계에서 해당 유형을 그대로 로드). 단 명시 유형의 파일이 삭제된 edge 케이스는 3단계가 인라인 fallback 처리.

### 절차

**1. sub-agent foreground 동시 spawn** — Agent tool 호출들을 **같은 응답 안에 함께 넣어** 병렬 실행:
- `speaker-label-correction` — diarize 오류 보정 → `transcript_speaker_edits.json` (**항상**)
- `speaker-mapping` — SPEAKER_XX → 이름 매칭 → `speaker_mapping.json` (`notes.json`의 화자 힌트가 있으면 ground-truth 앵커로 최우선 활용 — sub-agent가 자체 처리) (**항상**)
- `text-correction` — 음성 오인식·문맥 교정 → `transcript_text_edits.json` (**정밀 경로에서만**)
- `meeting-type-classification` — 회의 유형 결정 → 파일 미작성, **결정을 보고**(`TYPE_DECISION: ...`) (**`type`이 `auto`/비어있을 때만** — 위 "유형 분류 필요 여부 확인" 참고)

각 Agent prompt에 세션 디렉토리 절대 경로를 전달 (`$SESSION_DIR` 값을 inline으로 풀어 보냄):
```
세션 디렉토리:

{SESSION_DIR 값}

위 디렉토리의 transcript.txt를 시스템 프롬프트의 절차대로 분석해 [해당 출력 파일]을 작성하세요.
```

Agent tool은 같은 응답에 multiple invocation을 넣으면 **자동으로 병렬 실행됨**이 명시적으로 보장됩니다. foreground이므로 메인은 모든 결과를 받을 때까지 자동 대기.

sub-agent 모두 transcript.txt 원본을 read하고 sidecar는 호출하지 않음. sub-agent가 종료될 때까지 corrected.txt를 만들지 않음 (실패 시 재시작 용이).

**2. sub-agent 종료 후 corrected.txt 생성 + sidecar 적용** — **이 명령은 말없이 실행하세요.** "sub-agent 완료, 이제 교정본을 만들고 적용합니다" 류의 진행 중계를 출력하면 안 됩니다 (영어든 한국어든 금지 — [.claude/CLAUDE.md](../../CLAUDE.md) "도구 호출 직전·직후 중계 금지"). 사용자에게 낼 건 아래 "결과 처리"의 이모지 요약뿐입니다.

정밀 경로(text-correction을 spawn한 기본 케이스)면:
```bash
bash -c 'bash "$APP_DIR/lib/apply-corrections.sh" full'
```
빠른 경로(정밀 끔, text-correction 미spawn)면 인자 없이:
```bash
bash -c 'bash "$APP_DIR/lib/apply-corrections.sh"'
```

> **변수확장을 명령에 직접 쓰지 말 것** — `cp "$SESSION_DIR/..."`처럼 `$SESSION_DIR` 확장이 든 bash를 직접 발행하면 Claude Code가 "too-complex"로 분류해 sandbox 자동허용에서 탈락시켜 **매번 승인 프롬프트**가 뜬다(실측). 위 래퍼는 확장을 스크립트 내부에 가둬 발행 명령을 정적 분석 가능하게 만들어 프롬프트 없이 실행된다. 래퍼는 `$APP_SESSION_DIR`(PTY env)를 읽어 corrected.txt 생성 + `bin/apply-edits` 적용(`full`이면 텍스트 교정까지)을 수행한다.

cp으로 corrected.txt를 만들고 sidecar가 in-place 치환(라인 수·SPEAKER 라벨 보존). 적용 실패 항목은 자동 제외 → UI 매칭 정확성 보장. sidecar는 in-place라 두 종류의 적용 순서는 무관(라벨은 prefix, 텍스트는 본문 first-occurrence 치환).

### 결과 처리

sub-agent가 반환하는 보고를 종합해 사용자에게 표시하고 2단계로 진행:
```
🎤 화자 라벨 교정 완료 (M건 재할당)
🎤 화자 매핑 완료 (K명 식별 / J명 미확인)
```
**정밀 경로에서만** 위에 한 줄 더:
```
📝 전사 교정 완료 (N건 적용)
```

> **왜 sub-agent 병렬:** 메인 직접 처리 시 ~10분. 화자 작업을 sub-agent 병렬로 돌려 wall-clock을 max(sub-agent 시간)으로 줄임 + 메인 Opus 컨텍스트도 분석 부담 없이 후속 작성에 집중. 빠른 경로(정밀 끔)는 가장 느린 text-correction을 빼므로 더 빠르고, 정밀 경로(기본)는 전사본 품질을 위해 그것까지 포함.

---

## 2단계: 화자 식별 + 회의 내용 파악

교정된 전사본(`$SESSION_DIR/transcript_corrected.txt`)과 1단계 sub-agent 결과를 활용해 회의 내용을 파악합니다.

### 재작성 모드 감지 (선행 분기)

**`$SESSION_DIR/meeting-notes.bak.*.md` 백업 파일이 존재하면 재작성 모드** — 사용자가 유형 변경(restartCompose)으로 진입한 케이스입니다. 백업 파일은 frontend가 type 변경 직전 원본 `meeting-notes.md`를 `meeting-notes.bak.{ts}.md`로 이동(rename)해 생성합니다. 즉:

- 원본 `meeting-notes.md`는 rename으로 사라진 상태
- 백업 파일 1개 이상 존재
- LLM은 백업 파일 존재를 신호로 재작성 흐름 인지

**필수**: 2단계 진입 시 다음 ls를 **반드시 먼저 실행**하세요. 누락하면 재작성 모드인데도 첫 작성처럼 동작해 사용자가 이미 본 화자 매칭·요약 출력이 중복으로 노출됩니다.

```bash
# 백업 파일 존재 확인 (skip 금지)
ls "$SESSION_DIR"/meeting-notes.bak.*.md 2>/dev/null
```

재작성 모드 동작 — **출력만 skip하고 단계 흐름은 그대로 유지**:

- **화자 매칭·회의 요약 출력을 skip** (사용자가 이미 본 정보 반복 출력 회피)
- **품질 경고 출력 skip** (이미 첫 작성 시 노출됨)
- **AI 다듬기 완료 신호는 그대로 전송** — 사이드바 stepper "✓ AI 다듬기" 즉시 동기화:
  ```bash
  bash -c 'source "$APP_DIR/lib/signal.sh" && app_phase_step_done correct'
  ```
- **4단계 회의록 작성용 컨텍스트는 `transcript_corrected.txt` + `speaker_mapping.json`만 사용** — 새 type templates 골격에 맞춰 **처음부터 작성**. 백업 파일(`meeting-notes.bak.*.md`)은 **재작성 모드 감지 신호로만 사용하고 내용은 Read X** — 옛 type templates 구조로 정리된 본문이라 새 type 작성에 혼동·구조 복사 위험만 있음.
- **`transcript_corrected.txt`가 없으면** (로컬 AI 백엔드로 처음 작성된 세션을 이 스킬로 재작성하는 케이스 — 로컬 경로는 교정본을 만들지 않음): 재작성 모드라도 **1단계(화자 라벨 교정)를 정상 수행**해 교정본을 만든 뒤 진행하세요. 단 `speaker_mapping.json`에 이미 이름이 지정된 화자는 **매핑을 덮어쓰지 말고 유지** (사용자가 지정한 이름). 교정본 생성이 불가하면 `transcript.txt`로 4단계를 진행합니다.
- 화자 매칭/회의 요약 *출력*만 skip이지 LLM의 회의 내용 파악·분석은 그대로 수행 (재작성 모드의 효율 이점은 사용자에게 보이는 출력 중복 제거이지 LLM 작업 단축 X)
- **3 → 4 → 5단계는 첫 작성과 동일하게 모두 실행**. 5단계의 알림·`app_phase_done` 신호 누락 X — 신호가 없으면 frontend가 review 화면 전환·알림 전송을 못 함.

**백업 파일이 없으면 첫 작성** — 아래 절차 그대로 진행:

### 회의 내용 파악

> **교정본·매핑·notes.json을 읽고 분석하는 과정은 말없이 진행하세요.** "이제 교정본과 매핑을 읽어 회의 내용을 파악합니다"(영어 `Now let me read the corrected transcript, speaker mapping…` 포함) 류의 도구 호출 직전 중계를 출력하면 안 됩니다 ([.claude/CLAUDE.md](../../CLAUDE.md) "도구 호출 직전·직후 중계 금지"). 분석이 끝나면 아래 "화자 매칭 및 회의 요약 출력"의 이모지 블록만 냅니다.

파악할 내용:
- 회의의 전체 흐름 (어떤 주제들이 논의되었는지)
- 몇 명이 대화에 참여했는지
- 주요 화자가 누구인지 (매칭된 이름 기준)
- 회의 성격 추정 (발표·논의·보고·1:1 등 — 3단계 자동 판단의 입력)

**녹음 중 사용자 메모 활용** (`$SESSION_DIR/notes.json`이 있을 때만 — 없으면 무시):
- `kind: "text"`(자유 메모) 항목을 Read해 회의 내용 파악·회의록 작성의 보조 컨텍스트로 사용. `t`(경과 초)로 transcript의 해당 구간과 대응시킬 수 있음
- **사용자가 직접 입력한 신호이므로 우선순위 높음** — 사용자가 그 시점에 명시적으로 남기고 싶었던 내용(결정사항·핵심 주제·후속 메모 등)
- 단 **회의에 등장하지 않은 내용을 메모만 보고 지어내지 말 것** — 메모는 transcript 발화를 해석·강조하는 단서이지 발화를 대체하지 않음 (아래 "over-interpretation 방지"와 동일 원칙). `kind: "speaker"` 힌트는 화자 매핑용이라 여기선 무시


### 화자 매칭 및 회의 요약 출력

```
🎤 화자 매칭 (1차 추정 — 앱에서 최종 확인 필요)
- SPEAKER_03 → Bobs (근거: "Bobs 해주시죠" 직후 1인칭 응답 3:42)
- SPEAKER_01 → 미확인 (진행자, "오늘 데일리 시작하겠습니다" 0:03)
- SPEAKER_08 → 미확인 (백엔드, "X 기능 작업 중" 8:42)

📋 회의 요약
- 약 18분, 화자 10명
- 주요 주제: X PRD 검토, 일정 공유, 다음 스프린트 준비
```

**품질 경고 출력** (`_quality_warning`이 있는 경우만):
```
⚠️ 화자 분리 품질 경고: severe_overmerge
   최다 SPEAKER가 전체 발화의 94%를 차지합니다. 다수 화자가 한 SPEAKER로 합쳐진 것으로 보이므로,
   대부분 SPEAKER를 미확인으로 유지했습니다. 수동 매핑을 권장합니다.
```

### AI 다듬기 완료 신호

여기까지가 "AI 다듬기" 단계 — 사이드바 stepper에서 ✓ 표시되어 회의록 작성으로 전환됩니다:
```bash
bash -c 'source "$APP_DIR/lib/signal.sh" && app_phase_step_done correct'
```

---

## 3단계: 회의록 유형 결정

[`.claude/skills/meeting/notes-rules.md`](notes-rules.md)의 "회의 유형 결정" 절차를 따르세요. 회의 유형 가이드는 사용자 데이터 영역의 단일 위치(`~/Library/Application Support/app.junmit/templates/`)에서 로드한다 (앱이 첫 실행 시 기본 가이드를 자동 시드). 핵심 흐름:

1. `$SESSION_DIR/meeting.json`의 `type` 필드가 명시 templates 유형이면 → `~/Library/Application Support/app.junmit/templates/{type}.md`를 Read. **그 파일이 없으면**(사용자가 해당 유형을 삭제했거나 이름이 바뀐 경우) → 1단계에서 분류 sub-agent를 안 띄웠으므로 여기서 인라인 자동 판단(`notes-rules.md` "자동 판단" 기준 — 제목 × `title_keywords` 0순위 포함): 위 디렉토리의 모든 `*.md`의 frontmatter(`title_keywords`·`summary`)를 수집해 회의 제목·내용(`transcript_corrected.txt` + `meeting.json`의 `agenda`)과 매칭해 결정하고 `meeting.json.type` 갱신. 명시 유형이 사라졌다고 작성을 멈추지 말 것
2. `type`이 `free-form`이면 → 자동 판단 skip + `notes-rules.md`의 "Free-form 작성" 절차 직접 적용
3. `type`이 `auto` 또는 비어있으면 →
   - **1단계를 정상 수행한 경우**(첫 작성): `meeting-type-classification` sub-agent가 이미 결정했으므로 그 보고의 `TYPE_DECISION:` 값(유형 id 또는 `free-form`)을 채택해 **`meeting.json.type`에 즉시 갱신** (재분류하지 말 것 — 이미 병렬로 끝남).
   - **1단계를 skip한 경우**(`transcript_corrected.txt`가 이미 존재해 sub-agent를 안 띄움 — 재작성 모드 또는 크래시 후 재시도): 분류 sub-agent가 돌지 않아 `TYPE_DECISION` 보고가 **없습니다**. 이때는 여기서 **인라인 자동 판단**: 위 디렉토리의 모든 `*.md`의 frontmatter(`title_keywords`·`summary`)를 수집해 회의 제목·내용(`transcript_corrected.txt` + `meeting.json`의 `agenda`)과 매칭(`notes-rules.md` "자동 판단" 기준 — 제목 × `title_keywords` 0순위 포함) → 결정해 **`meeting.json.type`에 갱신**.
   - 어느 경우든 갱신 후 그 유형의 `{type}.md`를 Read (또는 `free-form`이면 free-form 절차로 진행).

결정 결과를 출력:
```
📄 회의 유형: 발표/세미나 (발표 주제 사전 정의 + Q&A 구조)
📄 회의 유형: free-form (양방향 1:1 대화, 정형 패턴 없음)
```

> `auto` → 결정 후 type 갱신은 한 번 판단된 결과를 보존하기 위함. 사용자가 다시 작성 시 같은 type이 적용되어 자동 판단 반복 없음. 사용자가 다시 LLM 판단을 원하면 회의록 탭 select에서 명시적으로 "자동 판단" 다시 선택. 갱신 절차는 `notes-rules.md`의 "type 갱신 절차" 참고.

---

## 4단계: 회의록 작성

회의록 본문 파일은 `$SESSION_DIR/meeting-notes.md`. **유형 가이드 로드·본문 작성은 말없이 진행하세요** — "이제 가이드를 불러와 회의록을 작성합니다" 류의 전환 멘트(영어 `Now let me load the type guide…` 포함)를 출력하면 안 됩니다 ([.claude/CLAUDE.md](../../CLAUDE.md) "도구 호출 직전·직후 중계 금지"). 작성이 끝나면 5단계의 `✅` 요약만 출력합니다. 다음 순서로 작성하세요:

0. **사전 로드** — `~/Library/Application Support/app.junmit/vocabulary.json`을 Read (공통 규칙 "음성 인식 오류 교정" 참고). 빠른 경로(정밀 끔)에선 전사 텍스트 교정 단계가 없으므로, 작성하면서 vocab·attendees·문맥으로 음성 오인식을 자체 교정해야 합니다.
1. **품질 경고 확인** — [`notes-rules.md`](notes-rules.md)의 "품질 경고 확인" 절차 적용 (`speaker_mapping.json`의 `_quality_warning`에 따라 분기)
2. **공통 규칙 적용** — `notes-rules.md`의 SPEAKER_XX sentinel, Action Items 분기, 결론 태그 규칙은 모든 유형에 공통
3. **유형별 골격 적용** — 3단계에서 결정한 `~/Library/Application Support/app.junmit/templates/{type}.md`의 작성 형식·원칙을 따라 작성. free-form인 경우 `notes-rules.md`의 "Free-form 작성" 절차
   - 가이드에 `## 예시 회의록` 섹션이 있으면 **구조·섹션·톤의 형식 참고로만** 사용 — 그 안의 자리표시자/샘플 내용(Bobs·{중괄호} 등)을 **회의록에 복사하지 말 것**. 본문은 실제 회의 내용으로 채웁니다

> 유형별 산문 가이드를 이 SKILL.md에 중복하지 않고 사용자 데이터 영역의 templates로 분리한 이유: 각 유형의 작성 형식을 단일 진실 원천으로 관리 + 사용자가 자기 컨텍스트에 맞춰 직접 편집/추가 가능.

---

## 5단계: 완료 신호

**첫 작성·재작성 무관 항상 모두 실행** — 특히 1번 `app_phase_done`을 누락하면 frontend가 Activity.Composing 상태에 멈춰 review 화면 전환·사용자 다음 작업 모두 차단됩니다. 작성 끝나면 즉시:

1. **회의록 작성 완료 신호 전송 (반드시 가장 먼저, 다른 단계와 무관 항상)** — 앱이 Activity.Idle 전환 + review 화면(회의록 탭) 노출 + 사이드바에 "AI에게 추가 요청"(에이전트 CLI 한정) 노출. 회의록 내보내기는 회의록 탭의 "복사" 버튼:
   ```bash
   bash -c 'source "$APP_DIR/lib/signal.sh" && app_phase_done'
   ```

   > 앱은 이 신호를 받아도 PTY는 종료하지 않습니다. 사용자가 결과 검토 중 추가 질문·개선 요청을 하면 같은 PTY에서 그대로 응답하세요. **이후 요청으로 세션 파일(`meeting-notes.md` 등)을 수정했다면 [.claude/CLAUDE.md](../../CLAUDE.md)의 "세션 파일 수정 공통 규칙"을 따르세요 — 대규모 수정 전 백업 + 수정 후 매번 `app_refresh`. 신호가 없으면 앱 화면에 수정 결과가 반영되지 않습니다.**

2. macOS 알림 전송 (사용자가 다른 앱에 있을 수 있으므로):
   ```bash
   bash -c 'source "$APP_DIR/lib/signal.sh" && app_notify "회의록이 준비되었습니다. 확인해주세요."'
   ```

3. 요약 출력 (사용자 정보용):
   - **첫 작성**:
     ```
     ✅ 회의록 작성 완료

     🎤 화자 매칭: {N}명 중 {K}명 식별 (나머지 미확인)
     📄 회의록: {유형} ({세션/논의 수}개 주제)
     ```
     **정밀 경로에서만** 맨 위에 `📝 전사 교정: {M}줄 교정` 한 줄 추가 (빠른 경로(정밀 끔)는 전사 텍스트 교정을 안 하므로 생략).
   - **재작성 모드** (1단계 sub-agent skip이라 M·N·K 값 없음 — 단순 출력):
     ```
     ✅ 회의록 재작성 완료 — 유형: {type} ({세션/논의 수}개 주제)
     ```

4. 마무리 안내 메시지:
   ```
   ✅ 회의록 작성 완료. review 화면에서 결과를 검토해주세요.
   추가 개선 요청이 있으면 이 터미널에서 계속 진행 가능합니다.
   ```

---

# 공통 규칙

## 회의록 작성용 도메인 컨텍스트

이 정보는 발화 맥락 이해 + 회의록 분류·요약 정확도용입니다. **회의에 등장하지 않은 정보를 회의록에 추가 금지** — 발화 그대로 옮기는 것이 우선. 자기 팀/조직의 서비스·도메인 컨텍스트가 필요하면 사용자 정의 회의 유형 가이드 본문에 적으세요.

### 주의 (over-interpretation 방지)

- 도메인 컨텍스트는 **발화 맥락 이해**용이지 **회의록 내용 추가**용이 아님
- 사용자가 직접 발화한 것만 회의록에 기록. 도메인 지식으로 elaboration·재해석 금지
- 매핑 미확인 시 추측 금지. cue 약하면 미확인 유지가 안전

## 음성 인식 오류 교정

**시작 전 사전 로드 (빠른 경로에서 특히 중요):** `~/Library/Application Support/app.junmit/vocabulary.json`의 `terms` 배열을 Read하세요. 사용자가 등록한 기술·도구·도메인 용어로, 회의록을 쓰면서 음성 오인식을 자체 교정하는 핵심 입력입니다. **빠른 경로(정밀 끔)에선 별도 전사 텍스트 교정(text-correction) 단계가 없으므로**, 회의록 작성자인 당신이 vocabulary·참석자 이름(meeting.json의 attendees)·문맥으로 직접 교정하며 본문을 작성해야 합니다. (정밀 경로에선 1단계 text-correction이 `transcript_corrected.txt`를 이미 교정했지만, vocab 프리로드는 무해하며 본문 작성 시 추가 안전망입니다.)

회의록 작성 시 반드시 문맥을 파악하여 교정하세요:
- **vocabulary.json의 용어**가 음성 오인식 형태로 등장 → 올바른 표기로 (예: "컴플문서"→"Confluence", "마이드레이션"→"마이그레이션")
- 문맥상 의미가 통하지 않는 단어 → 비슷한 발음의 올바른 단어로 교정
- 참석자 이름은 영어 이름. 한국어로 오인식된 경우 교정 (예: "밥스" → "Bobs") — meeting.json의 attendees 활용
- 기술 용어는 올바른 표기 (예: "엠에스에이" → "MSA", "에이비테스트" → "AB 테스트")
- 확실하지 않은 교정은 하지 마세요

## 화자 식별 주의사항

- **SPEAKER_XX 라벨은 자동 화자분리 결과이며 부정확할 수 있습니다.**
- **같은 SPEAKER_XX 안에서도 다른 사람의 발화가 섞여 있을 수 있습니다.** 발언 맥락(입장, 주장의 연속성)을 기준으로 판단하세요.
- 명확히 특정할 수 없는 화자는 `SPEAKER_XX` 라벨을 유지하고, `speaker_mapping.json`의 `name`을 빈 문자열(`""`)로 저장하세요. UI가 "미확인 (SPEAKER_XX)"로 자연스럽게 표시합니다. "참석자A" 같은 임시 이름을 발화 주체 표기에 쓰지 마세요 (매칭 변경 시 치환 불가).

## 규칙

- **모든 출력과 대화는 한국어로 진행하세요**
- **회의록 본문의 발화 주체 표기는 `SPEAKER_XX` 라벨을 그대로 사용**하세요 (예: `**SPEAKER_01**: ...`, `의견 (SPEAKER_03)`)
  - 이름 축약이나 placeholder로 변환하지 마세요. UI 렌더링 시점에 `speaker_mapping.json`을 참조해 실제 이름으로 치환됩니다
  - **단, 산문 안에 직접 언급된 인물 이름은 자연어 그대로** (예: "Bobs가 작년에 만든 V1") — sentinel은 발화 주체 식별의 불확실성에만 적용
- **speaker_mapping.json의 `name` 필드**만 attendees의 first name 토큰(예: `Bobs`) 또는 빈 문자열 — 매칭 정보의 단일 진실 원천
- 기술 용어는 올바른 영문 표기 (API, Kubernetes, Zustand 등)
