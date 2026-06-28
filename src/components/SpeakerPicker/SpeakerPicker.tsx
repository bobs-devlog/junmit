import { useState, useEffect, useMemo, useRef } from "react";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import { usePopover } from "./usePopover";
import styles from "./SpeakerPicker.module.css";

// 허용 문자: 한글, 영문, 숫자, 공백, 대시
const VALID_CHAR_RE = /[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s-]/g;
const MAX_NAME_LENGTH = 40;
const MAX_SUGGESTIONS = 10;

interface SpeakerPickerProps {
  value: string;
  attendees?: string[];
  onChange: (name: string) => void;
  trigger: (open: (e: ReactMouseEvent<HTMLElement>) => void) => ReactNode;
  speaker?: string;
  // 잠금(예: 교정 진행 중) — open을 차단해 팝오버가 열리지 않게 한다. 시각 표현은 호출부 trigger 담당.
  disabled?: boolean;
  // 제공되면 입력값이 명단에 없을 때 "새 참석자로 추가" 액션을 노출 — 추가 후 그 이름으로 매칭.
  // (creatable combobox 패턴) 명단 일괄 관리는 회의 정보 팝오버가 담당, 이건 이름 지정 중 단발 추가.
  onAddAttendee?: (name: string) => void;
  // ── 화자 검증(전사본) 통합용 — 상태별 근거/액션. 재할당 등 다른 사용처에선 미전달(미동작). ──
  // AI 근거(추정) 또는 역할 힌트(미확인). 팝오버 상단 블록으로 표시.
  reason?: string;
  // 매칭 상태 — 상단 액션 행을 결정.
  state?: "unset" | "guess" | "confirmed";
  // 추정 수락(확정). 호출 후 팝오버 닫힘.
  onConfirm?: () => void;
  // "모르겠어요" — 미확인 복귀. 호출 후 닫힘.
  onUnknown?: () => void;
  // 근거의 타임스탬프(M:SS) 클릭 시 호출 — 전사본 해당 줄로 점프. 호출 후 닫힘.
  onJumpToTime?: (t: string) => void;
}

/**
 * 화자 이름 선택 공통 컴포넌트 (팝오버)
 * - 현재 세션 참석자 중에서 선택
 * - onAddAttendee가 있으면 명단에 없는 이름을 입력해 "새 참석자로 추가"(creatable combobox)
 *
 * Props:
 *   value: 현재 이름
 *   attendees: string[] — 현재 세션 참석자
 *   onChange: (name: string) => void — 빈 문자열이면 매칭 해제
 *   onAddAttendee?: (name: string) => void — 명단에 없는 입력값을 새 참석자로 추가
 *   trigger: (open: (e) => void) => ReactNode — 클릭 시 팝오버 오픈
 *   speaker?: string — 팝오버 제목 (친화 라벨, 예: "참석자 3" 또는 이름)
 */
export default function SpeakerPicker({
  value,
  attendees = [],
  onChange,
  trigger,
  speaker,
  disabled = false,
  onAddAttendee,
  reason,
  state,
  onConfirm,
  onUnknown,
  onJumpToTime,
}: SpeakerPickerProps) {
  const [filter, setFilter] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1); // 키보드 네비게이션
  const listRef = useRef<HTMLDivElement | null>(null);

  const resetSearch = () => {
    setFilter("");
    setFocusedIndex(-1);
  };
  const { isOpen, open: openPopover, close, popoverStyle, popoverRef } = usePopover(resetSearch);

  const open = (e: ReactMouseEvent<HTMLElement>) => {
    if (disabled) return;
    openPopover(e);
    resetSearch();
  };

  const handleSelect = (name: string) => {
    onChange(name);
    close();
  };

  // 상태별 액션(확정/모르겠어요) — 실행 후 팝오버 닫음.
  const runAction = (fn?: () => void) => {
    fn?.();
    close();
  };

  // 근거 텍스트의 타임스탬프(M:SS)를 클릭 가능한 링크로 렌더 — 클릭 시 전사본 해당 줄로 점프 + 닫음.
  // onJumpToTime 미제공이면 평문 그대로(다른 사용처 안전).
  const renderReason = (text: string) => {
    if (!onJumpToTime) return text;
    return text.split(/(\d{1,3}:\d{2})/g).map((part, i) =>
      /^\d{1,3}:\d{2}$/.test(part) ? (
        <button
          key={i}
          type="button"
          className={styles.spTimeLink}
          onClick={() => {
            onJumpToTime(part);
            close();
          }}
        >
          {part}
        </button>
      ) : (
        <span key={i}>{part}</span>
      )
    );
  };

  // 입력값이 명단에 정확히(대소문자 무시) 없을 때만 "새 참석자로 추가" 노출.
  const trimmedFilter = filter.trim();
  const showCreate =
    !!onAddAttendee &&
    trimmedFilter.length > 0 &&
    !attendees.some((a) => a.toLowerCase() === trimmedFilter.toLowerCase());

  // 명단에 추가 + 그 이름으로 매칭 (한 동작). creatable combobox의 "Create 'X'".
  const handleCreate = () => {
    if (!trimmedFilter) return;
    onAddAttendee?.(trimmedFilter);
    onChange(trimmedFilter);
    close();
  };

  // 자동완성 목록: 현재 회의 참석자만
  const suggestions = useMemo(() => {
    if (!filter.trim()) return attendees;

    // prefix 우선, 그 다음 contains
    const f = filter.trim().toLowerCase();
    const prefix = [];
    const contains = [];
    for (const name of attendees) {
      const n = name.toLowerCase();
      if (n.startsWith(f)) prefix.push(name);
      else if (n.includes(f)) contains.push(name);
    }
    return [...prefix, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [attendees, filter]);

  // 키보드 탐색 항목 수 = 제안 + (생성 행 1). 생성 행 인덱스 = suggestions.length.
  const optionCount = suggestions.length + (showCreate ? 1 : 0);
  const isCreateFocused = showCreate && focusedIndex === suggestions.length;

  // 타이핑 중이면 첫 항목에 자동 포커스 (제안 없고 생성만 있으면 생성 행이 첫 항목).
  useEffect(() => {
    setFocusedIndex(filter.trim() && optionCount > 0 ? 0 : -1);
  }, [filter, optionCount]);

  // 포커스된 항목이 보이도록 스크롤
  useEffect(() => {
    if (focusedIndex < 0 || !listRef.current) return;
    const el = listRef.current.children[focusedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value.replace(VALID_CHAR_RE, ""));
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (optionCount === 0) return;
      setFocusedIndex((prev) => (prev + 1) % optionCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (optionCount === 0) return;
      setFocusedIndex((prev) => (prev <= 0 ? optionCount - 1 : prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // 포커스가 제안이면 선택, 생성 행(또는 포커스 없음 + 생성 가능)이면 새 참석자 추가.
      if (focusedIndex >= 0 && focusedIndex < suggestions.length) {
        handleSelect(suggestions[focusedIndex]);
      } else if (showCreate) {
        handleCreate();
      }
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <>
      {trigger(open)}
      {isOpen && (
        <div className={styles.spPopover} ref={popoverRef} style={popoverStyle}>
          {speaker && <div className={styles.spPopoverTitle}>{speaker}</div>}

          {/* AI 근거(추정)·역할 힌트(미확인) — 사용자가 판단할 핵심 단서 */}
          {reason && (state === "guess" || state === "unset") && (
            <div className={styles.spReason}>
              <span className={styles.spReasonLabel}>
                {state === "guess" ? "AI 추정 근거" : "AI 힌트"}
              </span>
              {renderReason(reason)}
            </div>
          )}

          {/* 상태별 액션 — 추정: 확정/모르겠어요, 확정: 확정 취소 */}
          {state === "guess" && (onConfirm || onUnknown) && (
            <div className={styles.spActions}>
              {onConfirm && (
                <button
                  className={clsx(styles.spAction, styles.spActionPrimary)}
                  onClick={() => runAction(onConfirm)}
                >
                  {value ? `${value} 맞아요` : "맞아요"}
                </button>
              )}
              {onUnknown && (
                <button className={styles.spAction} onClick={() => runAction(onUnknown)}>
                  모르겠어요
                </button>
              )}
            </div>
          )}
          {/* 추정 상태에선 숨김 — 이름은 "{이름} 맞아요" 버튼이, 해제는 "모르겠어요"가 대신하고
              "현재(정해진 것)"는 미확정 추정에 어울리지 않는다. 확정·기타 picker에선 그대로. */}
          {value && state !== "guess" && (
            <div className={styles.spPopoverCurrent}>
              <span className={styles.spPopoverCurrentLabel}>현재:</span>
              <strong>{value}</strong>
              <button className={styles.spPopoverClear} onClick={() => handleSelect("")}>
                해제
              </button>
            </div>
          )}

          <input
            className={styles.spPopoverInput}
            type="text"
            placeholder={onAddAttendee ? "이름 입력 (없으면 새로 추가)" : "이름 입력 또는 검색"}
            value={filter}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
          />

          {suggestions.length > 0 && (
            <div className={styles.spPopoverList} ref={listRef}>
              {suggestions.map((name: string, idx: number) => (
                <button
                  key={name}
                  className={clsx(
                    styles.spPopoverItem,
                    value === name && styles.selected,
                    idx === focusedIndex && styles.focused
                  )}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  onClick={() => handleSelect(name)}
                >
                  <span className={styles.spPopoverItemName}>{name}</span>
                </button>
              ))}
            </div>
          )}

          {showCreate && (
            <button
              className={clsx(styles.spPopoverCreate, isCreateFocused && styles.focused)}
              onMouseEnter={() => setFocusedIndex(suggestions.length)}
              onClick={handleCreate}
            >
              ➕ '{trimmedFilter}' 새 참석자로 추가
            </button>
          )}

          {suggestions.length === 0 && !showCreate && (
            <div className={styles.spPopoverEmpty}>
              {onAddAttendee ? (
                "이름을 입력해 새 참석자로 추가하세요"
              ) : (
                <>
                  {filter.trim() ? "일치하는 이름이 없습니다" : "등록된 참석자가 없습니다"}
                  <br />
                  <span className={styles.spPopoverEmptyHint}>
                    참석자 섹션에서 먼저 추가해주세요
                  </span>
                </>
              )}
            </div>
          )}

          <div className={styles.spPopoverHint}>
            {isCreateFocused ? "Enter로 새 참석자 추가" : "↑↓로 선택, Enter로 확정"}
          </div>
        </div>
      )}
    </>
  );
}
