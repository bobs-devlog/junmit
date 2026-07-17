import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { useAttendeeGroups } from "./useAttendeeGroups";
import styles from "./AttendeeList.module.css";

// 참석자 추가 입력에서는 쉼표를 구분자로 보존한다. split 이후 개별 이름에는 포함되지 않는다.
const VALID_INPUT_CHAR_RE = /[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s,-]/g;
const MAX_GROUP_NAME_LENGTH = 60;

interface AttendeeGroupControlsProps {
  attendees: string[];
  onAdd: (raw: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}

export default function AttendeeGroupControls({
  attendees,
  onAdd,
  inputRef,
}: AttendeeGroupControlsProps) {
  const { groups, saveGroup, removeGroup } = useAttendeeGroups();
  const [inputValue, setInputValue] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const areaRef = useRef<HTMLDivElement>(null);

  const closeSave = () => {
    setGroupName("");
    setSaveOpen(false);
  };

  useEffect(() => {
    if (!groupsOpen && !saveOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (areaRef.current?.contains(event.target as Node)) return;
      setGroupsOpen(false);
      closeSave();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [groupsOpen, saveOpen]);

  const handleAdd = () => {
    if (!inputValue.trim()) return;
    onAdd(inputValue);
    setInputValue("");
    setGroupsOpen(false);
  };

  const handleSave = () => {
    if (attendees.length === 0) return;
    saveGroup(attendees, groupName);
    closeSave();
    setGroupsOpen(true);
  };

  const handleDelete = (index: number) => {
    removeGroup(index);
    if (groups.length === 1) setGroupsOpen(false);
  };

  return (
    <div className={styles.alAddArea} ref={areaRef}>
      <div className={styles.alAddRow}>
        <input
          ref={inputRef}
          className={styles.alInput}
          type="text"
          placeholder="이름 추가 (예: Bobs, 김길동-외주)"
          value={inputValue}
          onFocus={() => !saveOpen && setGroupsOpen(groups.length > 0)}
          onChange={(e) => setInputValue(e.target.value.replace(VALID_INPUT_CHAR_RE, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
            else if (e.key === "Escape") setGroupsOpen(false);
          }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={handleAdd}
          disabled={!inputValue.trim()}
        >
          추가
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => {
            setGroupsOpen(false);
            setSaveOpen(true);
          }}
          disabled={attendees.length === 0}
        >
          참석자 그룹으로 저장
        </button>
      </div>

      {saveOpen && (
        <div className={styles.alSaveRow}>
          <input
            className={styles.alInput}
            value={groupName}
            autoFocus
            maxLength={MAX_GROUP_NAME_LENGTH}
            placeholder="그룹 이름 (선택)"
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              else if (e.key === "Escape") closeSave();
            }}
          />
          <button type="button" className="btn btn-secondary btn-small" onClick={handleSave}>
            저장
          </button>
          <button type="button" className={styles.alSaveCancel} onClick={closeSave} title="취소">
            ×
          </button>
        </div>
      )}

      {groupsOpen && groups.length > 0 && (
        <div className={styles.alGroupMenu}>
          {groups.map((group, index) => (
            <div className={styles.alGroupItem} key={index}>
              <button
                type="button"
                className={styles.alGroupSelect}
                onClick={() => {
                  setInputValue(group.attendees.join(", "));
                  setGroupsOpen(false);
                }}
              >
                {group.name && <span className={styles.alGroupName}>[{group.name}]</span>}
                <span className={styles.alGroupCsv}>{group.attendees.join(", ")}</span>
              </button>
              <button
                type="button"
                className={styles.alGroupDelete}
                onClick={() => handleDelete(index)}
                title="참석자 그룹 삭제"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
