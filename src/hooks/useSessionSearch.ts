// 회의 기록 검색 상태 훅 — 제목은 로드된 목록에서 즉시 필터, 본문(참석자·회의록·전사)은
// 입력이 멈추면 Rust(cmd_search_sessions)가 세션 파일을 훑어 합류시킨다.
import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionSearchHit } from "@/types";

// 본문 검색 하한 — Rust(search_sessions)와 같은 값. 1글자는 전사에서 사실상 전 세션에 걸림.
const BODY_SEARCH_MIN_CHARS = 2;
const BODY_SEARCH_DEBOUNCE_MS = 300;

// 출처 배지 라벨 + 정렬 그룹 순위 (제목 일치 그룹 다음에 참석자 → 회의록 → 전사 순).
export const HIT_SOURCE_META: Record<SessionSearchHit["source"], { label: string; rank: number }> =
  {
    attendees: { label: "참석자", rank: 1 },
    notes: { label: "회의록", rank: 2 },
    transcript: { label: "전사", rank: 3 },
  };

export interface SearchResult {
  session: Session;
  /** null = 제목 일치 (스니펫 없이 제목만 하이라이트). */
  hit: SessionSearchHit | null;
}

// 제목 일치(즉시)와 본문 일치(Rust)를 합쳐 표시 목록을 만든다. 제목 일치가 먼저, 본문 일치는
// 출처 그룹 순 — sort가 stable이라 그룹 안에서는 원래 목록 순서(최신순)가 유지된다.
function mergeSearchResults(
  sessions: Session[],
  query: string,
  bodyHits: SessionSearchHit[]
): SearchResult[] {
  const queryLower = query.trim().toLowerCase();
  if (!queryLower) return sessions.map((session) => ({ session, hit: null }));

  const titleMatches = sessions.filter((s) => s.title.toLowerCase().includes(queryLower));
  const titlePaths = new Set(titleMatches.map((s) => s.path));
  const sessionByPath = new Map(sessions.map((s) => [s.path, s]));

  const bodyMatches = bodyHits
    .filter((hit) => !titlePaths.has(hit.path))
    .flatMap((hit) => {
      const session = sessionByPath.get(hit.path);
      // 로드된 목록에 없는 세션(비유효 디렉토리)은 탈락 — Rust 쪽이 유효성 재검사를 안 하는 근거.
      return session ? [{ session, hit }] : [];
    })
    .sort((a, b) => HIT_SOURCE_META[a.hit.source].rank - HIT_SOURCE_META[b.hit.source].rank);

  return [...titleMatches.map((session) => ({ session, hit: null })), ...bodyMatches];
}

export default function useSessionSearch(sessions: Session[] | null) {
  const [query, setQuery] = useState("");
  // 본문 검색 응답은 자기 질의를 달고 저장된다 — 파생 시점에 현재 질의와 다르면 무시하므로
  // 늦게 도착한 이전 질의 응답이 최신 결과를 덮는 경합이 구조적으로 사라진다.
  const [bodySearch, setBodySearch] = useState<{ query: string; hits: SessionSearchHit[] }>({
    query: "",
    hits: [],
  });

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < BODY_SEARCH_MIN_CHARS) return;
    const timer = window.setTimeout(() => {
      invoke<SessionSearchHit[]>("cmd_search_sessions", { query: trimmed })
        .then((hits) => setBodySearch({ query: trimmed, hits }))
        .catch(() => {});
    }, BODY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useMemo(() => {
    const hits = bodySearch.query === query.trim() ? bodySearch.hits : [];
    return mergeSearchResults(sessions ?? [], query, hits);
  }, [sessions, query, bodySearch]);

  return { query, setQuery, results, searching: query.trim().length > 0 };
}
