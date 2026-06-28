import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { usePopover } from "./usePopover";
import styles from "./SpeakerPicker.module.css";

interface SpeakerTargetPickerProps {
  // 선택 가능한 화자 라벨 목록 (현재 전사의 SPEAKER 라벨, UNKNOWN 제외).
  speakers: string[];
  labelOf: (label: string) => string; // 친화 표시(이름 또는 "참석자 N")
  colorOf: (label: string) => string;
  allowNew?: boolean; // "+ 새 화자" 노출
  title?: string;
  // target = 선택한 라벨, 또는 "__NEW__"(새 빈 화자 라벨 생성).
  // 새 화자의 이름은 여기서 받지 않는다 — 다른 화자와 동일하게 전사본에서 그 라벨(칩)을 클릭해 지정.
  onChange: (target: string) => void;
  trigger: (open: (e: ReactMouseEvent<HTMLElement>) => void) => ReactNode;
  // 잠금(예: 교정 진행 중) — open을 차단. 시각 표현은 호출부 trigger 담당.
  disabled?: boolean;
}

/**
 * 화자 라벨 선택 팝오버 — 줄 단위 재할당의 타깃 선택(기존 화자 또는 새 빈 화자 라벨).
 * 이름(사람)을 고르는 SpeakerPicker와 달리 **화자 라벨**을 고른다. 팝오버 셸은 usePopover 공유.
 */
export default function SpeakerTargetPicker({
  speakers,
  labelOf,
  colorOf,
  allowNew = false,
  title,
  onChange,
  trigger,
  disabled = false,
}: SpeakerTargetPickerProps) {
  const { isOpen, open, close, popoverStyle, popoverRef } = usePopover();

  const openGuarded = (e: ReactMouseEvent<HTMLElement>) => {
    if (disabled) return;
    open(e);
  };

  const select = (target: string) => {
    onChange(target);
    close();
  };

  return (
    <>
      {trigger(openGuarded)}
      {isOpen && (
        <div className={styles.spPopover} ref={popoverRef} style={popoverStyle}>
          {title && <div className={styles.spPopoverTitle}>{title}</div>}

          {speakers.length > 0 ? (
            <div className={styles.spPopoverList}>
              {speakers.map((label) => (
                <button key={label} className={styles.spPopoverItem} onClick={() => select(label)}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: colorOf(label),
                      flexShrink: 0,
                    }}
                  />
                  <span className={styles.spPopoverItemName}>{labelOf(label)}</span>
                </button>
              ))}
            </div>
          ) : (
            !allowNew && <div className={styles.spPopoverEmpty}>옮길 다른 화자가 없습니다</div>
          )}

          {allowNew && (
            <button className={styles.spPopoverItem} onClick={() => select("__NEW__")}>
              <span className={styles.spPopoverItemName}>+ 새 화자로 빼내기</span>
            </button>
          )}

          {allowNew && (
            <div className={styles.spPopoverHint}>빼낸 뒤 그 라벨(칩)을 클릭해 이름 지정</div>
          )}
        </div>
      )}
    </>
  );
}
