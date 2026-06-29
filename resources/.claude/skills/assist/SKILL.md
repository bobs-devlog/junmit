---
name: assist
description: 회의록 작성 완료 후 사용자가 자유롭게 추가 요청할 때 진입하는 자유 대화 스킬. 빠른 인사로 시작하고 사용자 요청 분기에 따라 필요한 컨텍스트만 lazy load.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read Write Edit Bash AskUserQuestion mcp__atlassian__* mcp__claude_ai_Atlassian__* mcp__claude_ai_Google_Calendar__* mcp__claude_ai_Gmail__* mcp__claude_ai_Slack__* mcp__claude_ai_Notion__*
---

# AI 추가 요청 워크플로우

**세션 디렉토리는 `$APP_SESSION_DIR` 환경변수로 전달됩니다** (앱이 PTY spawn 시 설정).
$ARGUMENTS는 사용하지 않음 — 산문 placeholder도 일관성을 위해 `$SESSION_DIR` 사용.

```bash
SESSION_DIR="$APP_SESSION_DIR"
```

> **스크립트는 `$APP_DIR`(이 세션이 시작된 작업 루트)에 있습니다.** `signal.sh` 호출은 `$APP_DIR/lib/signal.sh` 절대경로로 하고 **절대 `cd` 하지 마세요.** `app_refresh`는 앱 회의록 탭 갱신의 신호라, `No such file`이 떠도 경로 오류이지 생략 사유가 아닙니다.

사용자가 사이드바 "AI에게 추가 요청" 또는 panel 빈 상태 버튼을 눌러 진입한 자유 대화 스킬.
`meeting`·`publish` 스킬과 달리 **`AskUserQuestion` 사용 허용**.

**핵심 원칙: 초기 응답 시간 최소화**. 무거운 컨텍스트 로드는 보류하고, 사용자 요청 분기에
따라 그때그때 필요한 파일만 lazy load. 익숙한 사용자는 추천 단계 없이 바로 작업 가능.

---

## 1단계 — 빠른 인사 (즉시)

`$SESSION_DIR/meeting.json`만 read해서 **회의 제목**만 확인. 다른 파일은 아직 read X.

사용자에게 짧은 인사 출력 (정확한 문구는 회의 컨텍스트에 맞춰 자연스럽게 다듬되 다음 톤 유지):

> "{title}" 회의록에 대해 무엇을 도와드릴까요?
> 어떤 작업이 가능한지 궁금하시면 "도와줘"라고 입력해주세요.

그리고 사용자 입력을 기다립니다. (claude code TUI 자체 입력 bar 활용)

---

## 2단계 — 사용자 입력 분기

사용자 입력의 의도를 파악해 세 가지로 분기:

### 분기 A — 구체 요청 (예: "3번 항목 빼줘", "결정사항 정리", "Jira 티켓 만들어줘")

**가장 빠른 경로.** 작업에 필요한 파일만 lazy load 후 즉시 3단계로.

예시:
- 회의록 본문 수정 요청 → `meeting-notes.md`만 read
- 화자 관련 요청 → `speaker_mapping.json` 추가 read
- Jira 티켓 → `meeting-notes.md`(액션 아이템 파싱용) read
- 회의 유형 변경 → `meeting.json` + 새 유형 가이드 read

### 분기 B — 도움 요청 (예: "도와줘", "도움", "뭐 할 수 있어?", "어떤 작업이 가능해?", "추천해줘")

**컨텍스트 종합 평가 경로.** 사용자가 정보·도움 요청한 경우만 실행. 정확한 키워드 매칭이
아니라 의도 파악 — 자연어로 "도움 필요해"·"막막하네" 같은 표현도 같은 분기.

전체 컨텍스트 로드:
- `meeting.json` (이미 1단계에서 로드됨)
- `meeting-notes.md`
- `speaker_mapping.json`
- `transcript_corrected.txt` (없으면 `transcript.txt`)
- `publish.json`

회의 상태 종합 평가 후 **현재 회의에 가장 적합한 작업 3~4개를 동적 선택**해 AskUserQuestion으로 제시.

선택지 결정 가이드 (회의 상태 기준):
- 회의록이 너무 길면 → "회의록 축약" 우선
- 액션 아이템이 명확하면 → "Jira 티켓 생성" 제안
- 결정사항이 빈약하면 → "결정사항 강화"
- 발행 완료된 회의이고 회의록 깔끔하면 → "Slack/메일 공유"
- 후속 미팅 약속 흔적이 있으면 → "캘린더 일정 등록"

선택지는 카탈로그(아래)에서 동적 선택. **마지막 옵션은 항상 "기타 (자유 입력)"**.
사용자가 선택지 클릭 후 3단계로.

### 분기 C — 모호한 요청 (예: "회의록 좋게", "정리해줘" — 어떤 작업인지 불명확)

의도를 좁히는 후속 AskUserQuestion. 분기 B와 같은 방식이지만 사용자가 이미 어느 영역인지
힌트 줬으므로 그 영역 안의 세부 선택지 우선 제시.

---

## 3단계 — 작업 수행

사용자 의도가 명확해진 후 작업 실행. **회의록 수정은 추가 확인 없이 직접 수정** —
만족 안 하면 다시 요청 가능합니다.

### 백업 가이드

회의록 본문 **대규모 수정**(섹션 재작성, 축약, 확장, 유형 변경, 톤 변경 등) 전엔 백업 생성:

```bash
cp "$SESSION_DIR/meeting-notes.md" "$SESSION_DIR/meeting-notes.bak.$(date +%Y%m%d_%H%M%S).md"
```

**작은 수정**(오타 정정, 항목 1개 삭제·추가, 문장 다듬기 등)은 백업 생략 — `.bak` 파일 누적
방지. 판단은 claude의 자율 — "이 정도면 사용자가 복구하고 싶을 변경인가?" 기준.

### 작업별 가이드

- **회의록 본문 수정**: 톤·길이·구조는 `notes-rules.md`와 회의 유형 가이드 기준 유지.
  SPEAKER_XX 라벨 보존 (앱이 표시 시점에 치환).
- **유형 변경**: `meeting.json`의 `type` 필드 갱신 + 새 유형 가이드로 재작성
  (meeting 스킬 재작성 패턴 참고). 본문 큰 변경이므로 백업 필수.
- **Jira 티켓 생성**: 액션 아이템 파싱 → AskUserQuestion으로 프로젝트 키·assignee 받기 →
  `mcp__claude_ai_Atlassian__createJiraIssue` 호출 → 회의록에 티켓 링크 삽입.
- **MCP 실패**: 인증 안 됨·권한 없음 등으로 실패하면 사용자에게 정확한 원인 안내 +
  다른 가능한 작업 제안.

---

## 4단계 — 결과 반영 + 알림

작업 완료 후:

```bash
bash -c 'source "$APP_DIR/lib/signal.sh" && app_refresh'
```

→ 앱의 SessionViewer 자동 reload.

사용자에게 **변경 내용을 1~3줄로 요약** 출력:

> 예: "결정사항 섹션을 정리했고 액션 아이템 3개를 추가했습니다. 회의록 탭에서 확인해주세요."

### 발행된 회의록 sync 안내

`publish.json`의 `confluence.published === true`이고 회의록 본문을 수정한 경우, 출력 끝에
한 줄 추가:

> Confluence에 반영하려면 사이드바 "다시 등록"을 눌러주세요.

로컬과 Confluence 페이지가 분기되는 것을 사용자가 인지하게 함.

---

## 5단계 — 추가 요청 대기

**`app_phase_done` 호출 X** — 자유 대화 스킬은 phase 개념 없음. PTY 유지, 사용자
추가 요청 가능.

추가 요청 시 1단계 인사는 생략하고 바로 2단계 분기부터 (이미 회의 컨텍스트 일부 파악됨).
사용자가 panel ✕ 또는 다른 사이드바 액션 trigger 시 자연 종료.

---

## 가능한 작업 카탈로그 (참고용 — 분기 B 시 선택)

회의 상태 보고 이 카탈로그에서 동적 선택. **고정 선택지 X**.

### 즉시 가능 — 로컬 파일

- 회의록 **축약**(짧게) / **확장**(자세히)
- **특정 섹션 다시 정리** (예: "결정사항만", "논의사항 3번")
- **결정사항·액션 아이템 강화**
- **톤·스타일 조정** (격식체 ↔ 구어체)
- **회의 제목 수정**
- **회의록 유형 변경** + 재작성 (presentation ↔ note ↔ review ↔ 사용자 정의)
- **회의 안건(agenda) 보강**
- **화자 매핑 검토** + 회의록 호칭 반영
- **결정사항만 별도 파일로 추출** (`decisions.md`)
- **회의록 요약본·풀버전 분리**

### 즉시 가능 — Atlassian MCP

- **Jira 티켓 자동 생성** — 액션 아이템 → 티켓 (assignee·프로젝트 키 받기)
- **이전 회의록 검색** — CQL/JQL로 비슷한 주제·attendee 회의 찾기 → cross-reference
- **Confluence 별도 페이지 등록** — 결정사항·요약본만 다른 space에
- **기존 페이지에 댓글로 변경사항 알림**

### MCP 인증되어 있으면 가능

- **Google Calendar 후속 미팅 일정 등록**
- **Gmail로 회의록 요약 메일 발송** (attendee들에게)
- **Slack 채널 공유**
- **Notion 페이지 백업**

### 향후 후보 (현재 미지원 — 우리 코드 확장 필요)

- **PDF/Word export**
- **영문/다국어 번역본**
- **화자별 발언 통계** (`transcript.txt` 화자 라벨 기반)
- **회의 키워드·태그 추출**
- **결정사항 follow-up 추적** (이전 회의 결정 진행 상황)

미지원 항목 사용자가 요청하면 친절히 안내 + 가능한 다른 작업 제안.

---

## 동작 원칙

- **출력·대화는 한국어 (첫 글자부터)** — `Let me…`/`Now I'll…` 류 영어 서두, "이제 ~하겠습니다"식 작업 메타 발화 금지. 1단계 인사부터 바로 한국어로 ([.claude/CLAUDE.md](../../CLAUDE.md) "사용자 친화 출력 규칙").
- **첫 응답은 최대한 빠르게** — 1단계에선 meeting.json만 read.
- **lazy load** — 분기 A에선 작업에 필요한 파일만 read. 모든 컨텍스트 미리 안 가져옴.
- **사용자 응답이 모호하면 AskUserQuestion 추가 사용** — 임의 작업 방지.
- **회의록 수정 후 항상 `app_refresh`** — UI 동기화 누락 방지.
- **MCP 도구 실패 시 명확히 안내** — 정확한 원인 + 다른 작업 제안.
- **익숙한 사용자 존중** — 명시 요청 받았으면 추천 거치지 않고 바로 작업.
