import { useLayoutEffect, useRef, useState } from "react";
import type { TextEdit } from "@/utils/textEdits";
import styles from "./TextEditTooltip.module.css";

// LLM이 교정한 단어를 본문 안에서 인라인 highlight + 호버 시 popover로 변경 정보 노출.
// native title은 1~2초 지연이 있어서 React state 기반으로 즉시 반응하도록 구현.
//
// 인라인 단어가 클릭 동작을 갖지 않게 (텍스트 자체라 클릭이 어색) hover 트리거만 사용.

interface TextEditTooltipProps {
  text: string;
  edit: TextEdit;
}

const VIEWPORT_MARGIN = 8;

export default function TextEditTooltip({ text, edit }: TextEditTooltipProps) {
  const [hover, setHover] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const isEstimated = edit.estimated === true;

  // 뷰포트 우측 경계를 넘으면 right 정렬로 뒤집어 화면 안에 들어오게 함
  useLayoutEffect(() => {
    if (!hover) {
      setAlignRight(false);
      return;
    }
    const node = popoverRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setAlignRight(rect.right > window.innerWidth - VIEWPORT_MARGIN);
  }, [hover]);

  return (
    <span
      className={styles.editedWord}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {text}
      {hover && (
        <span
          ref={popoverRef}
          className={`${styles.popover} ${alignRight ? styles.alignRight : ""}`}
          role="tooltip"
        >
          <span className={styles.change}>
            <span className={styles.old}>{edit.old}</span>
            <span className={styles.arrow}>→</span>
            <span className={styles.new}>{edit.new}</span>
          </span>
          {edit.reason && (
            <span className={styles.reason}>
              {isEstimated && <span className={styles.estimatedMarker}>❗</span>}
              {edit.reason}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
