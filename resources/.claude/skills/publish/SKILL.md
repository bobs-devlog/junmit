---
name: publish
description: 회의록을 publish.json 설정에 따라 Confluence에 자동 등록합니다.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read Write Edit Bash Agent mcp__atlassian__* mcp__claude_ai_Atlassian__*
---

# 회의록 발행 워크플로우

**세션 디렉토리는 `$APP_SESSION_DIR` 환경변수로 전달됩니다** (앱이 PTY spawn 시 설정).
$ARGUMENTS는 사용하지 않음 — claude code 슬래시 커맨드 파서가 quote를 처리하지 않아 공백이
포함된 macOS 경로(`Application Support` 등)를 인자로 안전하게 전달할 수 없기 때문.
산문 placeholder도 일관성을 위해 `$SESSION_DIR` 사용.

작업 시작 시 sessionDir을 변수로 잡아 사용:

```bash
SESSION_DIR="$APP_SESSION_DIR"
```

> **스크립트·바이너리는 `$APP_DIR`(이 세션이 시작된 작업 루트 — `lib/`·`bin/`이 여기 있음)에 있습니다.** 호출은 항상 `$APP_DIR/lib/…`·`$APP_DIR/bin/…` 절대경로로 하고 **절대 `cd` 하지 마세요.** 하네스가 "Base directory: …/skills/…"를 안내해도 스크립트는 거기 없습니다(스킬 폴더엔 문서만 있고 `lib/`·`bin/`은 없습니다). 특히 신호(`signal.sh`)는 앱 UI 전진의 **필수**라, `No such file`이 떠도 그건 경로/디렉토리 오류이지 생략 사유가 **아닙니다** — 신호를 임의로 건너뛰거나 "사용 불가"로 처리하지 마세요.

이 스킬은 `$SESSION_DIR/publish.json`의 설정대로 회의록을 Confluence에 등록합니다. **`AskUserQuestion` 사용 금지** — 모든 동작은 `publish.json` 기반 결정론적 처리.

**TodoWrite로 진행 상황 표시** — `confluence.mode === "create"` 분기 확인 직후 다음 3개 항목으로 todos를 초기화하고, 각 단계 진입 시 `in_progress`, 완료 시 `completed`로 마킹을 업데이트하세요. 사용자는 이 todos를 터미널 내 `⏺ Update Todos` 박스로 보며 진행 상황을 인지합니다. **공통 작성 규칙(영문 용어 금지·초기 상태·sub-agent 묶음)은 [.claude/CLAUDE.md](../../CLAUDE.md)의 "사용자 친화 출력 규칙" 참고.**

| # | content (명사형, 사용자 시점) | activeForm (진행형) | 매핑되는 단계 |
|---|---|---|---|
| 1 | 발행 준비 | 발행을 준비하는 중 | 1·2단계 (설정 확인 + 멘션·메타 준비) |
| 2 | Confluence 페이지 생성 | Confluence 페이지를 생성하는 중 | 3단계 (ADF 변환 + 페이지 생성·본문 주입) |
| 3 | 마무리 | 마무리하는 중 | 4단계 (결과 저장·신호·안내) |

스킬 특화 사항:
- **3단계의 sub-agent 위임은 "Confluence 페이지 생성" todo 한 항목으로 묶음** — 메인이 sub-agent 결과(`RESULT_URL` 등)를 파싱한 뒤 자체 마킹만 업데이트
- mode가 `append`·`skip`이면 todos 초기화 없이 즉시 종료 (각 mode의 사용자 안내 메시지만 출력)
- 단계별 한국어 안내 출력(`📤 Confluence 새 페이지 생성 모드 ...`, `✅ Confluence 등록 완료 ...` 등) 기존 형식은 그대로 유지 — TodoWrite는 그 위에 진행 지도를 덧붙이는 역할

호출자 측 전제(앱 frontend가 보장):
- `meeting-notes.md`, `speaker_mapping.json`, `meeting.json`, `publish.json` 모두 sessionDir에 존재
- `confluence.mode === "create"`인 케이스에만 이 스킬을 호출 (append/skip은 frontend 직접 처리)

---

## 1단계: 발행 설정 확인

`$SESSION_DIR/publish.json`을 읽어 `confluence.mode`를 확인하세요.

| mode | 동작 |
|---|---|
| `create` | 2단계로 진행 |
| `append` | 정상 흐름이면 호출되지 않음. "append 모드는 사용자 수동 처리 — 이 스킬은 호출되지 말아야 합니다" 출력 후 종료 (phase_done 보내지 않음) |
| `skip` 또는 파일 없음 | "발행 작업 없이 종료합니다" 출력 후 종료 (phase_done 보내지 않음 — frontend가 published 처리) |

확인 출력:
```
📤 Confluence 새 페이지 생성 모드
   상위 페이지: {parentUrl}
```

`parentUrl`이 비어있으면 "상위 페이지 URL이 비어있습니다. 발행 탭에서 입력해주세요" 출력 후 종료.

---

## 2단계: 메타 데이터 준비

**Read 3개를 단일 메시지에서 병렬 호출** (효율):
- `$SESSION_DIR/meeting.json` (4단계 페이지 title용)
- `$SESSION_DIR/speaker_mapping.json` (mention 후보 추출용)
- `$SESSION_DIR/publish.json` (재발행 stale 안내용 — `confluence.pageUrl`을 `$OLD_PAGE_URL` 변수에 저장. 비어있으면 빈 문자열. 4단계 마무리 안내에서 사용)

> `meeting-notes.md`는 LLM이 직접 read하지 않습니다 — **mention 후보 추출은 `bin/mention-cache extract-candidates`**, ADF 변환·SPEAKER 치환은 `bin/adf`가 sidecar로 처리합니다 (3단계). 본문이 14KB+에 달해 LLM이 토큰화·분석할 비용을 sidecar 위임으로 영구히 제거.

**이전 시도 잔존 파일 정리** — 부분 실패 후 재실행 시 stale 데이터 누적 방지:
```bash
rm -f "$SESSION_DIR/.publish-mentions.json" \
      "$SESSION_DIR/.publish-adf.json"
```
파일이 없어도 `rm -f`이므로 실패 X.

> **회의 제목 처리**: 본문에는 H1을 작성하지 않는 정책 ([notes-rules.md](../meeting/notes-rules.md)·templates 참고). 회의 제목은 `meeting.json.title`이 단일 진실 원천 — createConfluencePage의 title 인자로 전달. 만약 사용자가 본문에 H1을 박았다면 그대로 ADF에 들어가 페이지 본문 H1으로도 표시됨 (사용자 의도 존중).
>
> **날짜 prefix 자동 부여**: Confluence 페이지 트리·검색에서 동일 제목 회의(주간 회의·스탠드업·회고 등)를 날짜로 구분하기 위해, page title 앞에 `[MM/DD]` prefix를 자동으로 붙입니다. 앱 내부의 `meeting.json.title`은 그대로 두고 **Confluence로 전달하는 title만** 가공합니다. `meeting.json.date`(YYYY-MM-DD)에서 MM·DD를 추출하여 `[MM/DD] <기존 title>` 형태로 만듭니다. 예: title="Q2 OKR 점검", date="2026-05-11" → `[05/11] Q2 OKR 점검`.
>
> **사용자가 이미 날짜를 박은 경우 자동 prefix 건너뜀**: title 앞부분에 회의 날짜로 해석되는 표현이 명확히 있으면 가공 없이 그대로 사용합니다 (사용자 의도 존중 + 중복 방지).
> - **건너뜀 케이스**: `[05/11] ...`(재발행 시 동일 prefix), `[2026-05-11] ...`, `5/11 ...`, `2026.05.11 ...`, `5월 11일 ...`, `2026년 5월 11일 ...`
> - **그대로 prefix 추가 케이스**: `[MO] ...`(팀 약자), `Q2 ...`(분기), `2026년도 회고`(연도만) — 숫자가 있어도 명백히 회의 날짜가 아닌 경우
> - 모호하면 **보수적으로 prefix 추가** (사용자가 의도적으로 prefix를 뺐다면 명확한 날짜 표현을 썼을 것)

> **SPEAKER_XX 치환 자동화**: `adf`가 `--input` 파일과 같은 디렉토리의 `speaker_mapping.json`을 자동 검색해 변환 직전 치환합니다. publish 흐름의 input은 `$SESSION_DIR/meeting-notes.md`이고 mapping이 같은 디렉토리에 존재하므로 별도 단계 불필요. `name`이 빈 SPEAKER는 라벨 그대로 유지 (회의록 탭의 "미확인 (SPEAKER_XX)" 정책과 일관).

---

## 3단계: ADF 변환 (sub-agent 위임)

치환된 markdown을 ADF JSON으로 변환하고 Confluence 페이지를 생성합니다. **이 단계와 4단계를 sub-agent 1개에 위임하세요** — 본 turn의 컨텍스트 부담 회피.

### 왜 sub-agent 위임이 default

`createConfluencePage`·`updateConfluencePage` MCP의 `body`는 string 인자입니다. ADF JSON이 보통 수 KB ~ 수십 KB이므로 LLM이 tool-call 인자로 풀어쓰는 동안 사고시간 + 토큰 비용 + transcription 오류 위험이 큽니다 (실측 1회 publish 403초·시도 3회 사례 있음). sub-agent에 위임하면:
- main turn 컨텍스트는 sub-agent 호출·결과 URL만 포함 (깨끗)
- sub-agent 안에서만 ADF body 인라인 비용 발생 (격리) — 실패해도 main 흐름 무관
- 사용자 추가 요청 처리 속도 ↑

> **MCP 인터페이스 한계 회피 — placeholder + update 패턴**: createConfluencePage 한 번에 큰 body를 넘기는 대신, **(1) minimal placeholder body로 페이지 골격 먼저 생성 → (2) updateConfluencePage로 실제 본문 주입**의 2단계 패턴을 default로 채택. 큰 body 출력은 update 1회로 제한된다. 향후 백엔드(Rust) 직접 REST API 호출로 transcription 자체를 제거할 예정 — 그때 이 패턴도 단일 호출로 단순화될 것.

### 사전 작업 — mention 매핑 dict 작성 (main turn에서 수행)

mention dict 작성은 main turn에서 처리하세요 (Atlassian MCP 인증·search 호출이 main 컨텍스트로 묶임). 결과 dict JSON 파일만 sub-agent에 전달.

**cloudId 확보**:
- `publish.json`의 `confluence.parentUrl`에서 hostname 추출 (예: `your-domain.atlassian.net`) — 대부분 케이스에서 hostname을 cloudId로 직접 사용 가능
- 실패 시 `getAccessibleAtlassianResources`로 UUID fallback

**mention 후보 추출 + cache 일괄 조회** — sidecar 단일 호출로 처리 (LLM이 본문 직접 read X, 후보별 cache get 반복 호출도 X):

```bash
"$APP_DIR/bin/mention-cache" resolve --input "$SESSION_DIR/meeting-notes.md"
```

출력 형식 (JSON):
```json
{
  "all": ["Darin", "Bobs", "Floyd", ...],
  "hits": ["Bobs"],
  "misses": ["Darin", "Floyd", ...]
}
```

- `all`: dedup된 전체 후보 (build-dict 입력용)
- `hits`: cache hit firstName (Atlassian lookup 불필요)
- `misses`: cache miss firstName — 아래 lookup 절차 필요
- 내부 동작: speaker_mapping.json 자동 검색 → SPEAKER_XX 치환 → `@firstName` 정규식 매칭 → SPEAKER_ prefix 잔재 제외 → 후보별 cache 조회 일괄 처리
- 정책 [notes-rules.md](../meeting/notes-rules.md): 회의록은 `@firstName` 접두로 통일. `@` 없는 평문은 외부 참석자로 간주 (자동 제외됨). 영문 firstName만 대상 (회사 표준).

**`misses`의 각 firstName 처리** (Atlassian lookup):

`lookupJiraAccountId(cloudId, <firstName>)` MCP 호출 → 응답 `data.users.users` 배열 순회.

**검증 — 필수 (실측 검증됨)**:
- **`displayName.split()[0].toLowerCase() === firstName.toLowerCase()`** — 이름 첫 토큰 정확 일치. Atlassian search가 **prefix 매칭** 수행함이 확인됨 (`"Bobs"` 검색 시 `"Bobsy Smith"`·`"Bobson Park"`도 결과 포함 가능). 부분 매칭 제외 필수.

**자율 판단 (검증 부족, LLM이 응답 보고 결정)**:
- `accountType`은 실 응답에서 `"atlassian"` 값 1건만 확인됨. 다른 값(`"app"` bot, `"customer"` 등)이 환경에 있는지 미검증. **응답의 user가 명확히 bot/외부 사용자로 판단되면 skip** (예: displayName이 `[App]`으로 시작, accountType이 비인간 값 등). 의심스러우면 보수적으로 skip.
- `active` 필드는 실 응답에 **없음** — Atlassian 검색이 deactivated 사용자를 자동 제외한다는 일반 정책에 의존.

검증 통과 **첫 결과** 사용 → `accountId`, `displayName` 추출 → cache 저장:
```bash
"$APP_DIR/bin/mention-cache" set "<firstName>" "<accountId>" "<displayName>"
```

**검증 실패 또는 lookup 실패**: cache 저장 X, mention 노드 생성 X (다음 publish 시 다시 lookup). 회의록의 plain text `@<firstName>` 유지.

**동명이인** (정확 매칭 후 `total > 1`): 첫 결과 사용. 잘못된 mention 발견 시 cache 파일 수동 수정·삭제로 재조회.

### dict JSON 빌드 (sidecar 위임)

`misses` 처리 후 (또는 misses가 0개면 즉시), sidecar로 dict JSON 생성:

```bash
"$APP_DIR/bin/mention-cache" build-dict Darin Bobs Floyd ... > "$SESSION_DIR/.publish-mentions.json"
```

- 인자: resolve 출력의 `all` 리스트를 positional args로 전달 (LLM이 JSON에서 추출해 그대로 나열)
- `misses`가 0개면 LLM의 MCP lookup 단계 자체를 skip하고 build-dict로 바로 진행
- 출력: hit된 entry만 모은 lowercase-keyed JSON (miss는 자동 제외)
- 미인식 firstName은 자동으로 제외됨 — LLM이 dict를 손으로 JSON 작성할 필요 X

### sub-agent 호출

ADF 변환·Confluence 페이지 생성을 sub-agent에 위임합니다. Agent tool로 1회 호출 (foreground), 결과로 페이지 URL을 받습니다.

**호출 전 처리 (main turn)**: 페이지 title 가공.

1. **1차 판단** — 기존 `meeting.json.title` 앞부분에 회의 날짜로 해석되는 표현이 이미 있는가?
   - **있음**: title을 그대로 사용 (가공 건너뜀). 2단계 건너뛰고 sub-agent prompt에 그대로 박음.
     예: `[05/11] ...`, `[2026-05-11] ...`, `5/11 ...`, `2026.05.11 ...`, `5월 11일 ...`, `2026년 5월 11일 ...`
   - **없음**: 2단계로 진행하여 `[MM/DD]` prefix 부여.

   "없음" 판정 보조: 숫자가 있어도 명백히 회의 날짜가 아닌 경우(`[MO]`(팀 약자), `Q2`(분기), `2026년도 회고`(연도만) 등)는 "없음"으로 판정. 모호한 경우 보수적으로 "없음" 처리 (사용자가 prefix를 의도적으로 뺐다면 명확한 날짜 표현을 썼을 것).

2. **2차 가공** — `meeting.json.date`(YYYY-MM-DD)에서 MM·DD를 추출하여 `MM/DD` 형태로 만든 뒤 `[MM/DD] <기존 title>` 문자열로 결합.
   예: title="Q2 OKR 점검", date="2026-05-11" → `[05/11] Q2 OKR 점검`.

최종 문자열을 sub-agent prompt의 `title:` 라인에 직접 박아 넣음 (sub-agent는 받은 문자열을 그대로 createConfluencePage에 전달).

`subagent_type: general-purpose`로 호출, prompt에 다음을 포함:

```
세션: {SESSION_DIR 값}

다음 작업을 순서대로 수행하고 최종 페이지 URL을 한 줄로 출력하라:

1. ADF 변환 (SPEAKER → 이름 치환은 binary가 자동 처리):
   "$APP_DIR/bin/adf" convert \
     --input {SESSION_DIR}/meeting-notes.md \
     --mentions {SESSION_DIR}/.publish-mentions.json \
     --output {SESSION_DIR}/.publish-adf.json

2. parentUrl 파싱:
   - {SESSION_DIR}/publish.json의 confluence.parentUrl을 읽음
   - 패턴: https://{domain}/wiki/spaces/{SPACE}/pages/{ID}/...
   - personal space는 spaceKey가 ~로 시작 (예: ~bobs.kim)
   - spaceKey, parentId 추출

3. cloudId·spaceId 확보 (단일 메시지 병렬):
   - getAccessibleAtlassianResources → cloudId
   - getConfluenceSpaces(cloudId) → spaceKey 매칭으로 spaceId(숫자) 추출
   - createConfluencePage는 spaceId(숫자) 요구, spaceKey 아님

4. createConfluencePage 호출 — **placeholder body로 페이지 골격만 먼저 생성**:
   - cloudId
   - spaceId (숫자)
   - parentId
   - title: main turn이 가공한 prefixed title (위 "호출 전 처리" 결과 그대로 전달, 절대 재가공·재추출 금지)
   - body: 아래 minimal ADF placeholder (정확히 이 string 그대로):
     `{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"본문 업데이트 중..."}]}]}`
   - contentFormat: "adf"

   응답에서 pageId와 페이지 URL (`_links.webui` 또는 `_links.base` + `webui` 조합)을 추출해 변수에 저장.

   **이유**: createConfluencePage body로 14KB+ ADF JSON을 직접 출력하면 LLM의 tool-call 인자 transcription 사고시간이 회당 ~100초로 폭발하고 종종 입력 변형으로 인한 파싱 에러가 발생함이 실측됨. placeholder로 페이지 골격만 먼저 만들고(인자가 짧아 instant) 본문은 다음 단계의 updateConfluencePage로 주입한다.

5. updateConfluencePage 호출 — **실제 본문 주입**:
   - cloudId
   - pageId: 4단계 응답의 page id
   - title: 4단계와 동일한 title (재가공 금지)
   - body: **`cat {SESSION_DIR}/.publish-adf.json`의 출력을 그대로 전달**.
     절대 분석·요약·재서식·일부만 발췌 금지. 파일 첫 문자부터 마지막 문자까지 한 번에 인자에 출력.
   - contentFormat: "adf"
   - version: 4단계 응답의 `version.number` + 1 (createConfluencePage 직후이므로 보통 `2`).
     응답에 version 정보가 없으면 `2`로 가정.

6. 결과 출력 — **sentinel 라인 형식 필수** (Agent tool이 결과 뒤에 메타데이터를 자동으로 붙이는 경우가 있고, 메타가 sentinel 라인 끝과 공백 없이 합쳐지는 실측 케이스 존재 — 따라서 **URL은 반드시 따옴표로 감싸 종료 경계를 명확히** 한다):

   - **완전 성공** (4·5단계 모두 OK):
     ```
     RESULT_URL="<pageUrl>"
     ```

   - **부분 실패** (4단계 OK, 5단계 실패): 페이지는 Confluence에 존재하나 본문은 placeholder.
     ```
     RESULT_URL="<pageUrl>"
     RESULT_PARTIAL=1
     RESULT_ERROR=본문 업데이트 실패 — placeholder 본문으로 페이지 생성됨 (<원인>)
     ```

   - **완전 실패** (4단계도 실패):
     ```
     RESULT_ERROR=<사유>
     ```

   각 sentinel은 자체 줄(line)에 출력. URL은 따옴표로 감싸야 main turn의 grep이 메타데이터와 분리해 정확히 추출 가능 (URL에 `"`는 등장하지 않으므로 안전 종료 경계). `RESULT_PARTIAL`·`RESULT_ERROR`는 자유 텍스트라 따옴표 불필요. sentinel 외의 진단 메시지는 자유롭게 출력 가능.
```

> sub-agent는 main이 만든 `.publish-mentions.json`·`publish.json`·`meeting.json`·`meeting-notes.md` (+ 자동 검색되는 `speaker_mapping.json`)을 직접 Read합니다. main turn은 sub-agent 결과 마지막 줄(페이지 URL 또는 ERROR)만 파싱하면 됩니다.

### sub-agent 결과 처리

sub-agent 출력 전체에서 sentinel 라인을 `grep`으로 추출 (Agent tool이 끝부분에 메타데이터를 자동으로 붙일 수 있고, 메타가 sentinel 라인과 공백 없이 합쳐지는 케이스도 실측됨 — 따라서 URL은 sub-agent가 따옴표로 감싸 출력하고 grep이 따옴표 사이만 캡처):

```bash
# URL은 따옴표 사이만 캡처 — 메타가 같은 줄 뒤에 어떻게 붙어도 안전 (URL에 `"`는 없음)
RESULT_URL=$(echo "$SUB_AGENT_OUTPUT" | grep -oE '^RESULT_URL="[^"]+"' | head -1 | sed -e 's/^RESULT_URL="//' -e 's/"$//')
RESULT_PARTIAL=$(echo "$SUB_AGENT_OUTPUT" | grep -m1 '^RESULT_PARTIAL=' | sed 's/^RESULT_PARTIAL=//')
# 에러 메시지는 자유 텍스트 — 줄 끝까지 (메타가 같은 줄에 붙는 케이스는 드뭄. ERROR sentinel은 마지막 출력이라 보통 안전)
RESULT_ERROR=$(echo "$SUB_AGENT_OUTPUT" | grep -m1 '^RESULT_ERROR=' | sed 's/^RESULT_ERROR=//')
```

판정 분기:

| RESULT_URL | RESULT_PARTIAL | RESULT_ERROR | 판정 |
|---|---|---|---|
| ✅ 있음 | ❌ 없음 | ❌ 없음 | **완전 성공** — 4단계 "완전 성공" 흐름 |
| ✅ 있음 | ✅ 있음 | ✅ 있음 | **부분 실패** — 4단계 "부분 실패" 흐름 (pageUrl 저장, published=false, 사용자 안내) |
| ❌ 없음 | — | ✅ 있음 | **완전 실패** — 오류 출력, `publish.json` 변경 X (published=false 유지), `phase_done` 보내지 않음 — frontend가 Activity.Publishing → Activity.Idle 전이 후 재시도 가능 |
| 그 외 | — | — | 비정상 — 안전망으로 완전 실패 처리 |

---

## 4단계: 결과 기록 + 완료 신호

### 완전 성공 시 (sub-agent가 페이지 URL 반환)

1. **`publish.json` 갱신** — Read + JSON parse + 수정 + Write 패턴:
   - `Read`로 `$SESSION_DIR/publish.json` 읽기
   - JSON parse 후 `confluence.pageUrl`에 새 페이지 URL, `confluence.published = true` 설정
   - 다른 필드(`mode`, `parentUrl`)는 그대로 유지
   - `Write`로 `JSON.stringify(obj, null, 2)` 형태로 저장

   > ⚠️ Edit 도구로 JSON 부분 수정은 string match라 형식 깨질 위험. Read + parse + Write 패턴 권장.

2. **macOS 알림**:
   ```bash
   bash -c 'source "$APP_DIR/lib/signal.sh" && app_notify "회의록 등록이 완료되었습니다."'
   ```

3. **임시 파일 정리** — sub-agent가 만든 작업 파일 삭제 (다음 publish 시 stale 데이터 누적 방지):
   ```bash
   rm -f "$SESSION_DIR/.publish-mentions.json" \
         "$SESSION_DIR/.publish-adf.json"
   ```
   파일이 없어도 `rm -f`이므로 실패 X.

4. **완료 신호** (앱이 Activity.Idle 전환 + sidebar Primary "Confluence 열기"로 변경):
   ```bash
   bash -c 'source "$APP_DIR/lib/signal.sh" && app_phase_done'
   ```

5. **마무리 안내**:
   ```
   ✅ Confluence 등록 완료
   📄 {pageUrl}

   사이드바에서 "Confluence 열기"로 페이지를 확인할 수 있습니다.
   ```

   **재발행 케이스** — 2단계에서 백업한 `$OLD_PAGE_URL`이 비어있지 않고 새 URL과 다른 경우 다음 안내도 함께 출력:
   ```
   ⚠️ 이전에 등록한 페이지 {OLD_PAGE_URL} 는 Confluence에 그대로 남아있습니다.
       이번 등록은 새 페이지로 진행되었습니다.
       이전 페이지가 필요 없다면 Confluence에서 직접 삭제해주세요.
   ```

### 부분 실패 시 (sub-agent가 `PARTIAL_SUCCESS: <pageUrl>` + `ERROR: ...` 반환)

4단계의 createConfluencePage는 성공해 페이지가 Confluence에 생성됐지만, 5단계의 updateConfluencePage가 실패해 본문이 placeholder("본문 업데이트 중...") 상태인 케이스.

1. **`publish.json` 갱신** (URL만 저장, published=false 유지):
   - `confluence.pageUrl` = PARTIAL_SUCCESS의 URL
   - `confluence.published` = **false** (완료 X — 본문이 placeholder이므로)
   - 사용자 재발행 시 새 페이지가 생성되고 이 URL은 덮어써짐

2. **임시 파일 정리** — 위와 동일 (`rm -f` 두 파일).

3. **`phase_done` 신호 보내지 않음** — frontend가 Activity.Publishing → Activity.Idle 전이 후 재발행 가능 상태로.

4. **사용자 안내**:
   ```
   ⚠️ 페이지는 생성됐지만 본문 업데이트가 실패했습니다.
   📄 {pageUrl} (본문이 "본문 업데이트 중..." placeholder 상태)

   재발행을 권장합니다 (Confluence 에디터로 직접 채우면 @mention·action items 등 ADF 특성 일부가 살지 않습니다).
   재발행 시 새 페이지가 생성되며 이 placeholder 페이지는 사용자가 직접 삭제해야 합니다.
   ```

   **재발행 케이스** — 2단계에서 백업한 `$OLD_PAGE_URL`이 비어있지 않고 새 URL과 다른 경우 다음 안내도 함께 출력:
   ```
   ⚠️ 이번 시도 이전에 등록한 페이지 {OLD_PAGE_URL} 도 Confluence에 남아있습니다 (정리 필요).
   ```

### 재시도 시 안전성

`publish.json`에 `pageUrl`이 이미 있어도 **무시하고 새로 생성**하세요. 이전 시도가 실패했거나 사용자가 재발행을 의도한 케이스로 간주. 중복 페이지 생성은 사용자 책임 (재발행 confirm은 frontend가 처리).

---

## 금지 사항

- ❌ 영어 서두(`Let me…`/`Now I'll…`)·"이제 발행 설정을 확인합니다"식 작업 메타 발화 — 첫 글자부터 한국어, 진행은 `TodoWrite`로만, 첫 텍스트 출력은 `📤 …` 결과 요약부터 ([.claude/CLAUDE.md](../../CLAUDE.md) "사용자 친화 출력 규칙")
- ❌ 단계 번호·파일명(`publish.json` 등)·코드 식별자(`RESULT_URL` 등)를 사용자 출력에 노출 — 본문의 그 용어들은 내부 지침
- ❌ `AskUserQuestion` 사용 — `publish.json` 기반 결정론적 동작. 발행 설정은 사용자가 발행 탭에서 미리 입력
- ❌ 회의록 본문 (`meeting-notes.md`) 수정 — publish 스킬은 발행만 담당. 본문 편집은 refine 스킬에서
- ❌ SPEAKER 치환을 LLM이 Python/sed 등으로 직접 수행 — `bin/adf`가 변환 시점에 자동 치환 (sessionDir의 `speaker_mapping.json` 자동 검색)
- ❌ mention dict를 LLM이 JSON으로 직접 작성 — `bin/mention-cache build-dict` 사용
- ❌ mention 후보 firstName을 LLM이 본문에서 직접 추출 — `bin/mention-cache extract-candidates` 사용 (LLM이 14KB+ 본문을 토큰화·분석할 필요 없음)
- ❌ ADF JSON·`createConfluencePage` body를 main turn에서 LLM이 인라인으로 작성 — sub-agent에 위임 (3단계)
- ❌ createConfluencePage body에 실제 ADF JSON 직접 전달 — 항상 minimal placeholder. 본문은 updateConfluencePage로 (3단계 sub-agent prompt 4·5단계 참조)
- ❌ updateConfluencePage body 출력 중 분석·요약·재서식·일부 발췌 — `cat`한 파일 내용 그대로 한 번에 출력
- ❌ Markdown raw를 `body`로 전송 — 반드시 ADF JSON으로 변환
- ❌ Jira 티켓 생성 — 이 스킬은 Confluence 등록만 담당
- ❌ `parentId`/`spaceId` 잘못된 값으로 호출 — parentUrl 파싱 + getConfluenceSpaces 매칭 검증 후 호출
- ❌ `createConfluencePage`에 spaceKey 직접 전달 — spaceId(숫자) 필수
- ❌ `taskItem` 안에 `paragraph` wrapper — API가 거부 (adf가 자동 처리, 사용자 작업 불필요)
- ❌ `mention-map.json` 파일 LLM 직접 read/write — 항상 `bin/mention-cache` sidecar로만
- ❌ 산문 안 자연어 인물 이름을 mention 노드로 변환 — sentinel 정책 위배. 일반 text 유지 (adf 자동)

## 허용/지시 사항

- ✅ `publish.json` 모드 분기 (create/append/skip) — 1단계에서 명확히 처리
- ✅ SPEAKER_XX 치환 — `bin/adf` 변환 직전 자동 (sessionDir의 `speaker_mapping.json` 자동 검색)
- ✅ mention 후보 추출 — `bin/mention-cache extract-candidates` sidecar 위임 (LLM이 본문 직접 read X)
- ✅ mention dict 작성 — cache 조회 + Atlassian lookup → `bin/mention-cache set` 저장 → `build-dict`로 dict JSON 빌드
- ✅ ADF 변환 + createConfluencePage(placeholder) + updateConfluencePage(실제 본문) — sub-agent 1회 위임에 2-step 패턴으로 (3단계)
- ✅ MCP 호출 실패 시 graceful — 사용자에게 명확 안내, publish.json·phase_done은 변경 X
- ✅ updateConfluencePage 단계만 실패 시: 페이지는 placeholder로 존재 → ERROR 메시지에 명시하여 사용자가 인지·재발행 가능하게
