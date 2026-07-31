import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { useDialog } from "@/contexts/DialogContext";
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
  const { confirm } = useDialog();
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
      // 삭제 확인 모달 안에서의 클릭은 바깥 클릭으로 취급하지 않는다 (확인 중 드롭다운 유지)
      if ((event.target as Element).closest?.(".dialog-overlay")) return;
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

  const handleDelete = async (index: number) => {
    const group = groups[index];
    if (!group) return;
    const ok = await confirm({
      title: "참석자 그룹 삭제",
      body: `${group.name ? `[${group.name}] ` : ""}${group.attendees.join(", ")} 그룹을 삭제합니다. 되돌릴 수 없습니다.`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
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
          placeholder="이름 입력 후 Enter (쉼표로 여러 명)"
          value={inputValue}
          onFocus={() => !saveOpen && setGroupsOpen(groups.length > 0)}
          onChange={(e) => setInputValue(e.target.value.replace(VALID_INPUT_CHAR_RE, ""))}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") handleAdd();
            else if (e.key === "Escape") {
              if (inputValue) setInputValue("");
              else setGroupsOpen(false);
            }
          }}
          // blur도 커밋 — 새 이름 입력은 놓치면 조용히 사라지는 쪽이 위험(확정 행 편집과 반대 규칙, 의도적).
          onBlur={handleAdd}
        />
        <button
          type="button"
          className="btn btn-secondary btn-small"
          // 입력칸 blur 커밋이 목록을 한 줄 키워 이 버튼이 밀리면 클릭이 허공에 떨어진다.
          // 포커스 이동을 막고(blur 억제) 커밋은 onClick에서 직접 — 입력 중이던 이름도 그룹에 포함.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            handleAdd();
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

      {groupsOpen && !inputValue && groups.length > 0 && (
        <div className={styles.alGroupMenu}>
          {groups.map((group, index) => (
            <div className={styles.alGroupItem} key={index}>
              <button
                type="button"
                className={styles.alGroupSelect}
                onClick={() => {
                  onAdd(group.attendees.join(", "));
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
