// 회의 기록 카드 한 장 — 날짜·제목·(검색 시) 일치 스니펫·단계 칩. 스타일은 SessionList.module.css 공유.
import clsx from "clsx";
import { visibleSteps } from "@/constants";
import { HIT_SOURCE_META } from "@/hooks/useSessionSearch";
import type { SearchResult } from "@/hooks/useSessionSearch";
import type { Session } from "@/types";
import styles from "./SessionList.module.css";

// 정규식 예약문자 이스케이프 — 검색어는 자유 입력이라 "C++"·"(" 같은 문자가 그대로 온다.
// (내장 RegExp.escape는 lib ES2022 밖이라 사용 불가)
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 일치 구간을 <mark>로 감싼다 (대소문자 무시, 원문 표기 보존). query가 비면 원문 그대로.
// split의 캡처 그룹은 구분자(=일치 구간)를 결과 배열의 홀수 인덱스에 원문 그대로 남긴다 —
// 수동 스캔 루프 없이 끝나는 React 하이라이트 표준 관용구.
function Highlight({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const matcher = new RegExp(`(${escapeRegExp(trimmed)})`, "gi");
  return text
    .split(matcher)
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

interface SessionCardProps {
  result: SearchResult;
  /** 하이라이트할 검색어 — 검색 중이 아니면 빈 문자열. */
  query: string;
  onSelect: (session: Session) => void;
  onDelete: (e: React.MouseEvent, session: Session) => void;
}

export default function SessionCard({ result, query, onSelect, onDelete }: SessionCardProps) {
  const { session, hit } = result;
  return (
    <div className={styles.slItem} onClick={() => onSelect(session)}>
      <button
        type="button"
        className={styles.slDelete}
        onClick={(e) => onDelete(e, session)}
        aria-label="삭제"
        title="삭제"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" x2="10" y1="11" y2="17" />
          <line x1="14" x2="14" y1="11" y2="17" />
        </svg>
      </button>
      <div className={styles.slDate}>
        {session.date} {session.time}
      </div>
      <div className={styles.slTitle}>
        <Highlight text={session.title} query={query} />
      </div>
      {hit && (
        <div className={styles.slSnippet}>
          <span className={styles.slSnippetText}>
            <Highlight text={hit.snippet} query={query} />
          </span>
          <span className={styles.slBadge}>{HIT_SOURCE_META[hit.source].label}</span>
        </div>
      )}
      <div className={styles.slSteps}>
        {visibleSteps(session.ai_polish).map((step) => (
          <span
            key={step.id}
            className={clsx(styles.slStep, session.steps[step.field] && styles.done)}
          >
            {session.steps[step.field] ? "✓" : "·"} {step.label}
          </span>
        ))}
      </div>
    </div>
  );
}
