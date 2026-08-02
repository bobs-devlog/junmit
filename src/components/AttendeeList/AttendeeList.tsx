import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import clsx from "clsx";
import AttendeeGroupControls from "./AttendeeGroupControls";
import styles from "./AttendeeList.module.css";

// 허용 문자: 한글, 영문, 숫자, 공백, 대시 (SpeakerPicker와 동일 정책)
const VALID_CHAR_RE = /[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s-]/g;
const MAX_NAME_LENGTH = 40;

export interface AttendeeRowItem {
  /** React key용 안정 식별자 — 행 삭제 시 인덱스 key의 포커스·클릭 오귀속 방지. */
  uid: string;
  name: string;
  /**
   * 캘린더 유래 이메일 — 이름 옆에 표시해 귀속을 검증 가능하게. 수동 추가이거나 캘린더가
   * 이메일을 안 준 참석자(계정 소유자 본인 등)는 null이라 표시하지 않는다.
   * 이름 캐시 키는 별도(`AttendeeItem.id`)이며 화면에 내보내지 않는다.
   */
  email: string | null;
  /** true면 추정(미확정) — 점선 행 + 입력 필드 + 확정 버튼으로 렌더. */
  guessed: boolean;
  /** 추정 행을 최초 추정과 다르게 고쳤는지 — 확정 버튼 라벨(맞아요/저장) 전환. */
  edited: boolean;
}

/**
 * 참석자 리스트 (행 기반) — MeetingSelector 전용(녹음 전 참석자 선택·매핑).
 *
 * - 참석자는 **인덱스**로 식별(이름 아님) — 동명(휴리스틱 충돌 등)이어도 개별 처리 안전.
 * - 추정 행은 처음부터 입력 필드 — 캐시 귀속은 Enter·확정 버튼만(blur는 값만 유지).
 *
 * (화자 매칭 탭의 단순 태그 편집은 별도 `AttendeeEditor` 컴포넌트)
 */
interface AttendeeListProps {
  items: AttendeeRowItem[];
  onAdd: (name: string) => void;
  onRemove: (index: number) => void;
  /** 확정 행 인라인 편집 커밋 — 캐시 귀속은 호출자 책임. */
  onRename: (index: number, newName: string) => void;
  /** 추정 행 타이핑 — 이번 회의 값만 갱신(캐시 저장 아님). */
  onNameInput: (index: number, name: string) => void;
  /** 추정 행 확정(Enter·버튼) — 현재 값으로 캐시 귀속. */
  onConfirm: (index: number) => void;
  /** "이름 추가" 입력칸 ref — 호출자가 포커스를 줄 때 사용(예: 참석자 추가 유도). */
  addInputRef?: Ref<HTMLInputElement>;
}

export default function AttendeeList({
  items,
  onAdd,
  onRemove,
  onRename,
  onNameInput,
  onConfirm,
  addInputRef,
}: AttendeeListProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
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
  }, [items.length]);

  const handleAdd = (raw: string) => {
    const names = [
      ...new Set(raw.split(",").map((value) => value.trim().slice(0, MAX_NAME_LENGTH))),
    ].filter((name) => name && !items.some((item) => item.name === name));
    names.forEach(onAdd);
    if (names.length > 0) justAddedRef.current = true;
  };

  const startEdit = (index: number) => {
    setEditing(index);
    setEditValue(items[index]?.name ?? "");
  };

  const commitEdit = () => {
    if (editing === null) return;
    const trimmed = editValue.trim();
    const original = items[editing]?.name;
    if (trimmed && trimmed !== original) onRename(editing, trimmed);
    setEditing(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
  };

  const hasGuess = items.some((item) => item.guessed);
  const hasConfirmed = items.some((item) => !item.guessed);
  const hint = [
    hasGuess && "점선 칸은 확인이 필요한 이름이에요. 맞으면 [맞아요], 아니면 바로 고치세요.",
    hasConfirmed &&
      (hasGuess ? "나머지 이름도 클릭하면 고칠 수 있어요." : "이름을 클릭하면 고칠 수 있어요."),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={styles.alContainer}>
      <div className={styles.alLabel}>참석자 ({items.length}명)</div>

      {/* 섹션 전체를 컨테이너 박스 1개로 — 선택지(일정·유형)는 개별 카드, 데이터 목록은 컨테이너. */}
      <div className={styles.alBox}>
        {items.length > 0 && (
          <div className={styles.alListWrap}>
            <div className={styles.alList} ref={listRef} onScroll={updateMoreBelow}>
              {items.map((item, index) => (
                <div
                  key={item.uid}
                  className={clsx(styles.alRow, item.guessed && styles.alRowGuess)}
                  onClick={(e) => {
                    if (window.getSelection()?.toString()) return;
                    if (item.guessed) e.currentTarget.querySelector("input")?.focus();
                    else if (editing !== index) startEdit(index);
                  }}
                >
                  {item.guessed ? (
                    <input
                      className={styles.alGuessInput}
                      value={item.name}
                      maxLength={MAX_NAME_LENGTH}
                      aria-label="추정된 참석자 이름"
                      // 캘린더가 이름도 이메일도 안 준 참석자는 빈 칸으로 열린다.
                      placeholder="이름 입력"
                      onChange={(e) =>
                        onNameInput(index, e.target.value.replace(VALID_CHAR_RE, ""))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) onConfirm(index);
                      }}
                    />
                  ) : editing === index ? (
                    <input
                      className={styles.alRowEdit}
                      value={editValue}
                      autoFocus
                      aria-label="이름 편집"
                      maxLength={MAX_NAME_LENGTH}
                      onChange={(e) => setEditValue(e.target.value.replace(VALID_CHAR_RE, ""))}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") commitEdit();
                        else if (e.key === "Escape") cancelEdit();
                      }}
                      onBlur={commitEdit}
                    />
                  ) : (
                    <span className={styles.alRowName} title="이름 편집 (클릭)">
                      {item.name}
                    </span>
                  )}
                  {/* 버튼은 stopPropagation 필수 — ×를 안 막으면 삭제 후 버블된 클릭이 다음 행을 편집 모드로 연다. */}
                  {item.guessed && item.name.trim() !== "" && (
                    <button
                      className={styles.alConfirmBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onConfirm(index);
                      }}
                      title="이 이름으로 저장 (다음 회의부터 자동 적용)"
                    >
                      {item.edited ? "저장" : "맞아요"}
                    </button>
                  )}
                  {item.email && <span className={styles.alRowEmail}>{item.email}</span>}
                  <div className={styles.alRowControls}>
                    <button
                      className={styles.alRemove}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(index);
                      }}
                      title="삭제"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {moreBelow && <div className={styles.alListFade} aria-hidden="true" />}
          </div>
        )}

        <div className={clsx(styles.alAddSection, items.length > 0 && styles.alAddSectionDivided)}>
          <AttendeeGroupControls
            // 이름이 아직 빈 행(캘린더가 이름·이메일을 안 준 참석자)은 그룹에 넣지 않는다.
            attendees={items.map((item) => item.name.trim()).filter(Boolean)}
            onAdd={handleAdd}
            inputRef={addInputRef}
          />
        </div>
      </div>

      {/* 리스트 하단 1회 안내 — 자동 채운 이름과 클릭 편집을 행별 배지 대신 여기서 알린다.
          확정 행의 편집 가능 단서가 hover tooltip뿐이라 문구로 보완. */}
      {hint && <div className={styles.alHint}>{hint}</div>}
    </div>
  );
}
