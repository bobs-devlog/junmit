// 회의 전 브리핑 — 같은 시리즈의 지난 회의를 찾아 미결 액션을 상기시킨다.
//
// 매칭은 정규화된 제목 "완전 일치" 기준 — 주 경로인 캘린더 반복 일정은 매회 제목이
// 자동으로 동일하다(실데이터 시리즈 25회 전부 변형 0종). "10월 첫째주 위클리"처럼
// 날짜가 박힌 제목은 매칭되지 않는 알려진 한계인데, 리스크가 비대칭이라 의도된 선택:
// 못 찾으면 패널이 안 뜰 뿐(무해)이지만 잘못 찾으면 남의 액션이 떠서 신뢰가 깨진다.
// 그런 제목이 실제로 등장하면 그때 토큰 겹침 매칭을 실데이터 임계값 검증과 함께 도입.
//
// 액션 파싱은 회의록 체크박스 규칙(`- [ ] {task} @{담당자}`, notes-rules.md)과 짝.
// `- [x]`(체크됨)는 제외하지만, 현재 앱엔 체크 UI가 없어(미리보기는 비활성 렌더링,
// 편집 모드 수동 타이핑만 가능) 사실상 지난 회의 액션 전부가 나온다 — 그래서 UI 문구도
// "미결"이 아니라 "액션 아이템"이다. 체크 기능이 생기면 이 파서가 그대로 미결 필터가 된다.

import { invoke } from "@tauri-apps/api/core";
import type { Session } from "@/types";
import { substituteNames } from "@/utils/meetingNotes";
import { loadSpeakerMapping } from "@/utils/speakerMapping";

export interface Briefing {
  /** 지난 회의 날짜 (세션 메타 date 그대로) */
  date: string;
  title: string;
  path: string;
  /** 미결 액션 (화자 라벨은 표시 이름으로 치환됨) */
  openActions: string[];
}

// 제목 정규화 — 공백·구두점·대소문자 차이를 무시하고 시리즈 동일성 판정.
// 문자·숫자만 남긴다(\p{L}\p{N} — 전 스크립트). ⚠️ \W는 ASCII 기준이라 한글까지
// 지워버린다("모바일 기술논의" → "" — 리뷰에서 실측 발견). 유니코드 속성 이스케이프 필수.
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function parseOpenActions(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s\[ \]\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * 제목이 같은 가장 최근의 완료(회의록 있음) 세션에서 미결 액션을 수집한다.
 * 지난 회의가 없거나 미결 액션이 0개면 null — 브리핑의 목적이 액션 상기이므로
 * 보여줄 게 없으면 카드 자체를 띄우지 않는다.
 */
export async function loadBriefing(currentTitle: string): Promise<Briefing | null> {
  const key = normalizeTitle(currentTitle);
  if (!key) return null;

  const sessions = await invoke<Session[]>("cmd_find_sessions").catch(() => [] as Session[]);
  const prev = sessions
    .filter((s) => s.steps?.notes_written && normalizeTitle(s.title) === key)
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))[0];
  if (!prev) return null;

  const [md, mapping] = await Promise.all([
    invoke<string | null>("cmd_read_session_file", {
      sessionPath: prev.path,
      filename: "meeting-notes.md",
    }).catch(() => null),
    loadSpeakerMapping(prev.path).catch(() => null),
  ]);
  if (!md) return null;

  const openActions = parseOpenActions(substituteNames(md, mapping));
  if (openActions.length === 0) return null;

  return { date: prev.date, title: prev.title, path: prev.path, openActions };
}
