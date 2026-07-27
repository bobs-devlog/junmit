#!/usr/bin/env bash
# 정본(.claude) → 에이전트 CLI 공용 산출물(.agents/skills + AGENTS.md) 생성.
# 산출물은 Codex와 Antigravity(agy)가 함께 읽는다 — 둘 다 워크스페이스 스킬을
# `.agents/skills/<name>/SKILL.md`(name+description frontmatter)에서, 지시 파일을
# AGENTS.md에서 스캔하는 동일 규약(agy는 동봉 문서 실측, cwd→저장소 루트 walk-up 로드).
#
# 단일 소스 원칙: 사람이 편집하는 곳은 항상 resources/.claude/ 한 곳.
# 이 스크립트가 스캔 경로(.agents/skills)와 지시 파일(AGENTS.md), 그리고 Codex 커스텀
# 에이전트(.codex/agents/*.toml — .claude/agents 전체 파생)를 생성한다.
# 산출물은 gitignored — app-dev/app-build(package.json)와 release.sh가 실행 전 재생성한다.
#
# CLI별 차이는 두 층으로 나눠 다룬다:
#   1) 어휘 치환(sed, 아래 NEUTRALIZE) — 1:1 대응 도구·표현만.
#      Codex 실측: update_plan은 TodoWrite와 동일한 pending/in_progress/completed 의미론,
#      request_user_input은 AskUserQuestion 대응. frontmatter는 Claude 전용 키만 제거
#      (Codex는 name+description만 쓰고, 권한은 샌드박스/승인 플래그·config.toml로 다룬다).
#      치환 결과 도구명은 Codex 표기 — Antigravity는 AGENTS.md의 자기 절에서 재해석한다.
#   2) 구조 차이(Agent tool 문법 등) — sed로 본문을 뜯지 않고 AGENTS.md 끝의
#      "에이전트 CLI 해석 규칙"이 CLI별 전역 해석을 지시한다 (본문 절차 원형 유지 = 정본과 diff 최소).
# 본문 절차·신호 호출(signal.sh)·`.claude/...` 경로 참조는 그대로 둔다 — cwd가 resources/라
# 어느 CLI에서든 동일하게 읽힌다 (.claude/agents/의 named agent 정의 포함).
set -euo pipefail

RES_DIR="$(cd "$(dirname "$0")/../resources" && pwd)"
SRC="$RES_DIR/.claude/skills"
DST="$RES_DIR/.agents/skills"

rm -rf "$DST"
mkdir -p "$DST"

# 어휘 치환 규칙 — 스킬 본문과 CLAUDE.md(→AGENTS.md)에 공통 적용.
NEUTRALIZE=(
  # frontmatter: Claude 전용 키 제거
  -e '/^disable-model-invocation:/d'
  -e '/^user-invocable:/d'
  -e '/^allowed-tools:/d'
  # 도구명: Codex 대응 도구로 직접 매핑 (조사 동반 케이스를 먼저 — 받침 차이 보정)
  -e 's/`TodoWrite`로/`update_plan`으로/g'
  -e 's/`TodoWrite`가/`update_plan`이/g'
  -e 's/TodoWrite로/update_plan으로/g'
  -e 's/TodoWrite는/update_plan은/g'
  -e 's/TodoWrite가/update_plan이/g'
  -e 's/TodoWrite/update_plan/g'
  -e 's/AskUserQuestion/request_user_input/g'
  # MCP 도구명: claude 네임스페이스 prefix 제거 → atlassian 서버의 bare 도구명
  -e 's/mcp__claude_ai_Atlassian__//g'
  # claude TUI 특화 표현 → CLI-중립
  -e 's/터미널 내 `⏺ Update Todos` 박스로/터미널 내 진행 체크리스트로/g'
  -e 's#(claude 입력 bar 활용)#(입력란 활용)#g'
  -e 's#(claude code TUI 자체 입력 bar 활용)#(터미널 입력란 활용)#g'
  -e 's/판단은 claude의 자율/판단은 모델의 자율/g'
  -e 's/claude code 슬래시 커맨드 파서/CLI 명령 파서/g'
  # 공통 규칙 문서 링크: .agents/skills/<name>/ 기준 상대 경로로 AGENTS.md를 가리키게
  -e 's#\[\.claude/CLAUDE\.md\](\.\./\.\./CLAUDE\.md)#[AGENTS.md](../../../AGENTS.md)#g'
)

# 스킬 디렉토리별로 모든 .md를 변환 복사 — SKILL.md 외 참조 자산(notes-rules.md 등)도
# 함께 가야 상대 링크가 산출물 안에서 닫힌다.
for dir in "$SRC"/*/; do
  name="$(basename "$dir")"
  mkdir -p "$DST/$name"
  for md in "$dir"*.md; do
    sed "${NEUTRALIZE[@]}" "$md" > "$DST/$name/$(basename "$md")"
  done
done

# Codex 커스텀 에이전트 TOML — .claude/agents/*.md 전체를 파생 생성 (스킬의 .agents 변환과 대칭).
# codex에서 하위 에이전트별 설정(reasoning effort 상한 등)을 거는 유일한 통로가 커스텀 에이전트
# 정의이고, spawn 경로를 "항상 커스텀 에이전트 이름으로" 하나로 통일하기 위해 전량 생성한다.
# 절차 본문은 복사하지 않는다 — developer_instructions가 정본 .md를 읽도록 지시해 단일 소스 유지.
# frontmatter `effort:`가 있는 에이전트만 model_reasoning_effort를 실어 번역한다
# (Claude `max`는 codex 최고 티어 xhigh로), 없으면 부모 세션 effort 상속(기존과 동일).
CODEX_DST="$RES_DIR/.codex/agents"
rm -rf "$RES_DIR/.codex"
mkdir -p "$CODEX_DST"
for md in "$RES_DIR/.claude/agents"/*.md; do
  front="$(sed -n '2,/^---$/p' "$md")"
  name="$(basename "$md" .md)"
  desc="$(printf '%s\n' "$front" | sed -n 's/^description: *//p' | head -1)"
  effort="$(printf '%s\n' "$front" | sed -n 's/^effort: *//p' | head -1)"
  [ "$effort" = "max" ] && effort="xhigh"
  {
    echo "name = \"$name\""
    echo "description = \"$desc\""
    [ -n "$effort" ] && echo "model_reasoning_effort = \"$effort\""
    cat <<EOF
developer_instructions = """
당신은 $name 하위 에이전트입니다.
작업 절차: 워크스페이스 루트의 .claude/agents/$name.md 를 읽고 그 지침 그대로 수행하세요
(frontmatter의 model·effort·tools 값은 Claude 전용 설정이므로 무시 — codex 쪽 설정은 이 파일이 정의).
호출자 prompt가 전달한 세션 디렉토리·작업 파라미터를 대상으로, 작업 정의가 지정한 산출물만 만듭니다
(출력 파일 작성 또는 보고 — 그 외 파일은 수정하지 않습니다).
"""
EOF
  } > "$CODEX_DST/$name.toml"
done

# AGENTS.md = 출력 규칙(CLAUDE.md 중립화) + CLI별 해석 규칙(구조 차이 전역 지시).
{
  sed "${NEUTRALIZE[@]}" -e 's#`\.claude/skills/`#`.agents/skills/`#g' "$RES_DIR/.claude/CLAUDE.md"
  cat <<'EOF'

## 에이전트 CLI 해석 규칙 (Codex · Antigravity)

스킬 본문(.agents/skills)은 Claude Code와 공유하는 단일 정본에서 생성되며, 이 산출물은
Codex와 Antigravity(agy)가 함께 읽습니다. 본문의 `update_plan`·`request_user_input`은
Codex 도구명 표기입니다 — 자신이 어느 CLI인지에 따라 아래 해당 절의 해석을 따르세요.

공통 (양쪽 모두):

- **`mcp__<서버>__*` 형태의 도구명**: 해당 MCP 서버의 같은 이름 도구를 사용하세요
  (예: create_event, search_threads).

### Codex로 실행 시

- **sub-agent / Agent tool 위임 지시**: Codex에서는 `multi_agent` 하위 에이전트로
  위임하세요. 모든 worker 작업은 워크스페이스 `.codex/agents/`에 같은 이름의 **커스텀
  에이전트**로 정의되어 있습니다. spawn 요청 문구에 커스텀 에이전트 이름을 명시해 그 정의로
  실행되게 하세요 (`spawn_agent` 도구는 `agent_type` 인자를 받지 않으므로 이름은 도구 인자가
  아니라 요청 문구로 씁니다). prompt에는 세션 디렉토리 절대 경로와 작업별 파라미터(검증 담당
  범위 등)만 전달합니다 — 작업 절차는 각 정의의 developer_instructions가 정본
  `.claude/agents/<이름>.md`를 읽도록 이미 지시합니다. 커스텀 에이전트가 인식되지 않는
  환경이면 기존 방식(worker 역할을 prompt에 명시하고 정본 .md를 먼저 읽어 그대로 따르라고
  지시)으로 폴백하세요.
- **병렬 spawn 지시**: 서로 다른 출력 파일만 쓰는 독립 작업은 같은 응답에서
  하위 에이전트를 모두 생성하고, 모두 끝날 때까지 기다린 뒤 결과를 종합하세요. `/meeting`
  1단계의 하위 에이전트 수는 **meeting.json의 ai_polish + type에 따라** 갈립니다 —
  `ai_polish: false`(AI 다듬기 끔)면 하위 에이전트를 **하나도 만들지 않고** 메인이 원본
  전사로 곧장 진행하고(SKILL.md "AI 다듬기 여부 확인"의 OFF 절차 — 화자 힌트 반영·완료
  신호 포함), 그 외(`true` 또는 없음, **기본=다듬기 포함**)면 speaker-label-correction·
  speaker-mapping·text-correction **기본 3개**를 반드시 병렬로 시작합니다. **추가로 `type`이
  `auto`이거나 비어있으면**(다듬기 ON에서만) meeting-type-classification 하위 에이전트도
  **함께 병렬 spawn**해 회의 유형을 후보정과 동시에 결정합니다. 이 에이전트는 파일을 쓰지 않고 결정을
  `TYPE_DECISION:` 형식으로 보고하며, 메인이 1단계 종료 후 meeting.json.type에
  반영합니다 (SKILL.md "유형 분류 필요 여부 확인" 참고). 6단계 자기검증의
  notes-verification 2개도 같은 방식(병렬 생성 → 모두 대기 → 보고 종합)입니다.
  각 하위 에이전트에는 세션 디렉토리 절대 경로와 담당 출력 파일을 명시하고,
  transcript 원본과 다른 하위 에이전트 출력은 수정하지 말라, sidecar는 호출하지 말라, 지정된
  JSON 파일 하나만 작성하라고 지시합니다. 전체 대화 히스토리 fork는 피하고 필요한 경로와
  작업 정의만 prompt에 넣으세요. 결과를 받은 뒤 완료된 하위 에이전트 thread는 정리해
  동시 실행 슬롯을 비웁니다.
- **하위 에이전트 도구가 비활성인 경우**: 조용히 순차 대체하지 말고, Codex 하위 에이전트
  기능을 사용할 수 없어 병렬 1단계를 진행할 수 없다고 사용자에게 알리고 중단하세요.
  순차 대체는 성능 회귀를 숨기므로 금지합니다. "sub-agent 묶음" 마킹 규칙은 해당 단계를
  plan 항목 하나로 유지하는 것으로 동일 적용합니다.
- **request_user_input 도구가 비활성인 경우**: 같은 선택지를 평문 번호 목록으로 출력하고
  사용자 입력을 기다리세요.

### Antigravity(agy)로 실행 시

- **`update_plan` 지시**: 네이티브 계획/작업 목록 기능이 있으면 **작업 시작 즉시** 각 단계를
  한국어 이름으로 등록하고 전환마다 갱신하세요(pending/in_progress/completed 의미론 동일).
  그 기능이 없으면 **단계가 바뀔 때마다 한 줄짜리 한국어 진행 알림**을 출력하세요
  (예: `🎤 화자를 분석하고 있어요…`). 이 한 줄 알림은 진행 표시 수단이 따로 없는 환경의
  대체물이므로 메타 발화 금지 규칙의 **예외**입니다 — 단, 한 단계에 한 줄을 넘기지 말고
  도구 호출을 일일이 중계하지 마세요.
- **영어 문장 금지 (중요)**: 도구 호출 사이의 짧은 상태 문장("timer is set", "waiting for
  subagents" 류)을 포함해 **사용자에게 보이는 모든 평문은 예외 없이 한국어**로 출력하세요.
  사고 요약·도구 라벨이 영어인 것은 어쩔 수 없지만, 당신이 직접 쓰는 문장까지 영어면
  사용자는 무슨 일이 일어나는지 알 수 없습니다.
- **`request_user_input` 지시**: 네이티브 사용자 질문 도구가 있으면 사용하고, 없으면 같은
  선택지를 평문 번호 목록으로 출력하고 사용자 입력을 기다리세요.
- **sub-agent / Agent tool / 병렬 spawn 지시**: 네이티브 하위 에이전트(subagent) 기능으로
  위임하세요. 하위 에이전트 수와 병렬 시작 조건은 위 Codex 절 "병렬 spawn 지시" 규칙을
  그대로 따릅니다 — `invoke_subagent`는 background 실행이므로 spawn한 하위 에이전트
  **전원의 완료를 확인한 뒤** 다음 단계로 진행합니다 (`manage_subagents` list로 상태 확인 가능).
  각 하위 에이전트에는 세션 디렉토리 절대 경로와 담당 출력 파일을 명시하고, 작업 정의
  `.claude/agents/<이름>.md`를 먼저 읽어 그대로 따르라고 지시하며, transcript 원본과 다른
  하위 에이전트의 출력은 수정하지 말 것·sidecar는 호출하지 말 것·지정된 파일 하나만 작성할
  것을 함께 지시합니다.
- **하위 에이전트 기능이 없는 경우**: 조용히 순차 대체하지 말고, 병렬 1단계를 진행할 수
  없다고 사용자에게 알리고 중단하세요(Codex 절과 동일 정책 — 순차 대체는 성능 회귀를
  숨기므로 금지).
EOF
} > "$RES_DIR/AGENTS.md"

# 자가 검증 — 정본에 새 claude 전용 표현이 추가되면 빌드를 시끄럽게 실패시킨다
# (조용히 새서 codex 런타임에서 의문사하는 것 방지). 새 표현은 NEUTRALIZE에 규칙 추가로 해소.
if leftover=$(grep -rn \
    -e 'TodoWrite' -e 'AskUserQuestion' -e 'mcp__claude_ai' \
    -e 'claude 입력 bar' -e 'claude code TUI' -e 'claude code 슬래시' \
    -e 'Codex에는 해당 도구가 없습니다' -e '순차 수행으로 대체' \
    -e 'agent_type: "worker"' \
    -e '## Codex 해석 규칙' \
    -e '^allowed-tools:' -e '^disable-model-invocation:' -e '^user-invocable:' \
    "$DST" "$RES_DIR/.codex" "$RES_DIR/AGENTS.md"); then
  echo "오류: 산출물에 claude 전용 표현이 남았습니다. NEUTRALIZE에 치환 규칙을 추가하세요:" >&2
  echo "$leftover" >&2
  exit 1
fi

echo "생성 완료:"
echo "  - $DST/{$(cd "$SRC" && ls -d */ | xargs -n1 basename | paste -sd, -)}"
echo "  - $RES_DIR/AGENTS.md"
echo "  - $CODEX_DST/{$(cd "$CODEX_DST" && ls | paste -sd, -)}"
