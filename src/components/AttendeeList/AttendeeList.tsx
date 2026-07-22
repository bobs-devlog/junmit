import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import clsx from "clsx";
import AttendeeGroupControls from "./AttendeeGroupControls";
import styles from "./AttendeeList.module.css";

// 허용 문자: 한글, 영문, 숫자, 공백, 대시 (SpeakerPicker와 동일 정책)
const VALID_CHAR_RE = /[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s-]/g;
const MAX_NAME_LENGTH = 40;

/**
 * 참석자 리스트 (행 기반) — MeetingSelector 전용(녹음 전 참석자 선택·매핑).
 * 이름 + 이메일 + 추정/확정 상태를 한 줄에 보여주고 인라인 편집·확정·삭제.
 *
 * - 참석자는 **인덱스**로 식별(이름 아님) — 동명(휴리스틱 충돌 등)이어도 개별 처리 안전.
 * - 이름은 자유 형식(한글·풀네임 허용).
 * - `guessed[i]` = 이메일에서 추정한 이름 → 흐리게 + "추정" 배지 + "확정" 버튼.
 * - 이름 수정/확정 시 호출자가 이메일-키 캐시에 귀속(다음 회의 자동 적용).
 *
 * (화자 매칭 탭의 단순 태그 편집은 별도 `AttendeeEditor` 컴포넌트)
 */
interface AttendeeListProps {
  attendees: string[];
  /** attendees와 같은 길이. 각 참석자 이메일(있으면) — 식별용으로 행에 표시. */
  emails?: (string | null)[];
  /** attendees와 같은 길이. true면 "추정"으로 흐리게 + 배지 + 확정 버튼. */
  guessed?: boolean[];
  onAdd: (name: string) => void;
  onRemove: (index: number) => void;
  onRename: (index: number, newName: string) => void;
  /** 추정 이름을 수정 없이 현재 값 그대로 확정(캐시). */
  onConfirm: (index: number) => void;
  /** "이름 추가" 입력칸 ref — 호출자가 포커스를 줄 때 사용(예: 참석자 추가 유도). */
  addInputRef?: Ref<HTMLInputElement>;
}

export default function AttendeeList({
  attendees,
  emails = [],
  guessed = [],
  onAdd,
  onRemove,
  onRename,
  onConfirm,
  addInputRef,
}: AttendeeListProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  // 스크롤 리스트 — 아래에 더 있는지(moreBelow) 단서 + 추가 시 맨 아래로 스크롤.
  const listRef = useRef<HTMLDivElement>(null);
  const justAddedRef = useRef(false);
  const [moreBelow, setMoreBelow] = useState(false);

  const updateMoreBelow = () => {
    const el = listRef.current;
    if (el) setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };

  // 참석자 수 변동 시: 방금 직접 추가한 경우 맨 아래로 스크롤(새 항목 노출), 스크롤 단서 갱신.
  useEffect(() => {
    if (justAddedRef.current) {
      justAddedRef.current = false;
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    updateMoreBelow();
  }, [attendees.length]);

  const handleAdd = (raw: string) => {
    const names = [
      ...new Set(raw.split(",").map((value) => value.trim().slice(0, MAX_NAME_LENGTH))),
    ].filter((name) => name && !attendees.includes(name));
    names.forEach(onAdd);
    if (names.length > 0) justAddedRef.current = true;
  };

  const startEdit = (index: number) => {
    setEditing(index);
    setEditValue(attendees[index] ?? "");
  };

  const commitEdit = () => {
    if (editing === null) return;
    const trimmed = editValue.trim();
    const original = attendees[editing];
    if (trimmed && trimmed !== original) onRename(editing, trimmed);
    setEditing(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
  };

  return (
    <div className={styles.alContainer}>
      <div className={styles.alLabel}>참석자 ({attendees.length}명)</div>

      <div className={styles.alListWrap}>
        <div className={styles.alList} ref={listRef} onScroll={updateMoreBelow}>
          {attendees.map((name, index) => (
            <div key={index} className={clsx(styles.alRow, guessed[index] && styles.alRowGuess)}>
              {editing === index ? (
                <input
                  className={styles.alRowEdit}
                  value={editValue}
                  autoFocus
                  maxLength={MAX_NAME_LENGTH}
                  onChange={(e) => setEditValue(e.target.value.replace(VALID_CHAR_RE, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    else if (e.key === "Escape") cancelEdit();
                  }}
                  onBlur={commitEdit}
                />
              ) : (
                <span className={styles.alRowNameWrap}>
                  <span
                    className={styles.alRowName}
                    title={
                      guessed[index]
                        ? "이메일에서 추정한 이름 — 클릭해 확인·수정"
                        : "이름 편집 (클릭)"
                    }
                    onClick={() => startEdit(index)}
                  >
                    {name}
                  </span>
                  <button
                    className={styles.alEditBtn}
                    onClick={() => startEdit(index)}
                    title="이름 수정"
                  >
                    ✎
                  </button>
                </span>
              )}
              {/* 추정행은 점선 보더 + "이대로 사용" 버튼으로 식별 — 별도 배지는 의미가 겹쳐 제거.
                  확인 안내는 아래 리스트 도움말이 담당. */}
              {guessed[index] && editing !== index && (
                <button
                  className={styles.alConfirmBtn}
                  onClick={() => onConfirm(index)}
                  title="이 이름이 맞음 — 그대로 사용(다음 회의에도 자동 적용)"
                >
                  이대로 사용
                </button>
              )}
              {emails[index] && <span className={styles.alRowEmail}>{emails[index]}</span>}
              <div className={styles.alRowControls}>
                <button className={styles.alRemove} onClick={() => onRemove(index)} title="삭제">
                  ×
                </button>
              </div>
            </div>
          ))}
          {attendees.length === 0 && <span className={styles.alEmpty}>참석자 없음</span>}
        </div>
        {moreBelow && <div className={styles.alListFade} aria-hidden="true" />}
      </div>

      {/* 추정행이 있을 때만 1회 안내 — 자동 채운 이름임을 행별 배지 대신 리스트에서 알린다. */}
      {guessed.some(Boolean) && (
        <div className={styles.alHint}>자동으로 채운 이름이에요. 맞는지 확인하거나 수정하세요.</div>
      )}

      <AttendeeGroupControls attendees={attendees} onAdd={handleAdd} inputRef={addInputRef} />
    </div>
  );
}
