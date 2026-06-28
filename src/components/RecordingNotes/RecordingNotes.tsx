import { useState, useRef, useLayoutEffect, memo } from "react";
import clsx from "clsx";
import type { MeetingNote } from "@/types";
import styles from "./RecordingNotes.module.css";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Props {
  // meeting.json의 참석자 이름들 — 화자 힌트 칩으로 노출.
  attendees: string[];
  // 누적 메모 (시간순). 시간순 그대로 표시 — 최신이 아래, 새 항목 추가 시 맨 아래로 추종.
  notes: MeetingNote[];
  // 현재 발화자 = name 앵커 추가 (현재 elapsed에 기록).
  onAddSpeaker: (name: string) => void;
  // 자유 메모 한 줄 추가.
  onAddText: (text: string) => void;
  // 텍스트 메모 본문 수정 (원본 인덱스 기준). 화자 힌트는 수정 대상 아님.
  onEditText: (index: number, text: string) => void;
  // notes 배열의 원본 인덱스 기준 삭제.
  onRemove: (index: number) => void;
}

// 녹음 화면 본문의 메모 패널. 회의 중 저마찰 캡처가 목적 —
// 참석자 칩 1탭(화자 앵커), 짧은 자유 메모.
// 텍스트 메모는 추가/수정/삭제, 화자 힌트는 추가/삭제 (수정은 삭제 후 재탭).
// 하단 memo() — 레벨 미터 60Hz 리렌더가 이 패널에 번지지 않게(부하 큰 입력 중 버벅임 방지). 떼지 말 것.
function RecordingNotes({
  attendees,
  notes,
  onAddSpeaker,
  onAddText,
  onEditText,
  onRemove,
}: Props) {
  const [draft, setDraft] = useState("");
  // 인라인 수정 중인 텍스트 메모의 원본 인덱스 + 편집값 (AttendeeList 패턴).
  const [editing, setEditing] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const hasSpeakers = attendees.length > 0;

  // 메모 리스트는 시간순(최신이 아래). 새 항목 추가 시 맨 아래로 추종하되,
  // 사용자가 위로 스크롤해 과거를 보는 중이면 방해하지 않는다(채팅 관례).
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const handleListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // 맨 아래 근처(40px 이내)면 추종 유지, 위로 올렸으면 추종 해제.
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // 항목 수가 바뀔 때(추가·삭제)만 추종 — 텍스트 인라인 수정(길이 불변)은 스크롤 건드리지 않음.
  // paint 전에 위치를 잡아 깜빡임 없이 맨 아래로.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [notes.length]);

  const submitText = () => {
    const text = draft.trim();
    if (!text) return;
    onAddText(text);
    setDraft("");
  };

  const startEdit = (index: number, current: string) => {
    setEditing(index);
    setEditValue(current);
  };

  const commitEdit = () => {
    if (editing === null) return;
    const trimmed = editValue.trim();
    // 빈 값은 무시(삭제는 ✕로). 변경 없으면 그대로 종료.
    if (trimmed && trimmed !== notes[editing]?.text) onEditText(editing, trimmed);
    setEditing(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
  };

  return (
    <div className={styles.notes}>
      <div className={styles.header}>
        <span className={styles.title}>녹음 메모</span>
        <span className={styles.hint}>
          {hasSpeakers
            ? "말하는 사람을 누르거나 메모를 남기면 회의록이 정확해져요"
            : "메모를 남기면 회의록 작성에 도움이 돼요"}
        </span>
      </div>

      <div className={styles.list} ref={listRef} onScroll={handleListScroll}>
        {notes.length === 0 && (
          <span className={styles.empty}>
            {hasSpeakers ? "표시한 화자와 메모가 여기에 쌓입니다" : "입력한 메모가 여기에 쌓입니다"}
          </span>
        )}
        {notes.map((note, index) => {
          const isText = note.kind === "text";
          const isEditing = isText && editing === index;
          return (
            <div key={index} className={styles.row}>
              <span className={styles.time}>{formatTime(note.t)}</span>
              {isEditing ? (
                <input
                  className={styles.edit}
                  value={editValue}
                  autoFocus
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    else if (e.key === "Escape") cancelEdit();
                  }}
                  onBlur={commitEdit}
                />
              ) : (
                <span
                  className={clsx(styles.content, styles[note.kind], isText && styles.editable)}
                  title={isText ? "메모 수정 (클릭)" : undefined}
                  onClick={isText ? () => startEdit(index, note.text ?? "") : undefined}
                >
                  {note.kind === "speaker" && <>🎙 {note.speaker}</>}
                  {isText && note.text}
                </span>
              )}
              {isText && !isEditing && (
                <button
                  type="button"
                  className={styles.editBtn}
                  onClick={() => startEdit(index, note.text ?? "")}
                  title="메모 수정"
                >
                  ✎
                </button>
              )}
              <button
                type="button"
                className={styles.remove}
                onClick={() => onRemove(index)}
                title="삭제"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className={styles.footer}>
        {hasSpeakers && (
          <div className={styles.chipsBlock}>
            <span className={styles.chipsLabel}>지금 말하는 사람을 누르세요</span>
            <div className={styles.chips}>
              {attendees.map((name, i) => (
                <button
                  key={`${name}-${i}`}
                  type="button"
                  className={styles.chip}
                  onClick={() => onAddSpeaker(name)}
                  title={`${name} 발화 시점 표시`}
                >
                  🎙 {name}
                </button>
              ))}
            </div>
          </div>
        )}

        <input
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitText();
            }
          }}
          placeholder="메모 입력 후 Enter"
        />
      </div>
    </div>
  );
}

export default memo(RecordingNotes);
