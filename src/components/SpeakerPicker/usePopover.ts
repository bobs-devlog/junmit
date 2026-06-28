import { useState, useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

// 화자 picker 류 팝오버의 위치 계산·외부 클릭 닫기 공통 훅.
// SpeakerPicker(이름 지정)와 SpeakerTargetPicker(화자 라벨 선택)가 공유 — 포지셔닝 중복 방지.

interface PopoverPos {
  top: number;
  left: number;
  openUp: boolean;
}

/**
 * @param onClose 팝오버가 닫힐 때(외부 클릭·close 호출) 호출. 호출자의 부가 state(검색어 등) 초기화용.
 */
export function usePopover(onClose?: () => void) {
  const [popover, setPopover] = useState<PopoverPos | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setPopover(null);
    onClose?.();
  };

  // click outside로 닫기
  useEffect(() => {
    if (!popover) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popover]);

  const open = (e: ReactMouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const openUp = rect.bottom + 320 > window.innerHeight;
    // 우측 가장자리 트리거(예: 탭바 우측 '회의 정보')에서 팝오버가 화면 밖으로 넘치지 않도록
    // left를 뷰포트 안으로 클램프. 화면 중앙 앵커(화자 picker)는 rawLeft가 작아 영향 없음.
    const POPOVER_W = 360;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_W - 8));
    setPopover({ top: openUp ? rect.top : rect.bottom, left, openUp });
  };

  const popoverStyle: CSSProperties | undefined = popover
    ? popover.openUp
      ? { bottom: window.innerHeight - popover.top + 4, left: popover.left }
      : { top: popover.top + 4, left: popover.left }
    : undefined;

  return { isOpen: !!popover, open, close, popoverStyle, popoverRef };
}
