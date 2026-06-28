import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import clsx from "clsx";
import TerminalPanel, { type TerminalPanelHandle } from "../TerminalPanel";
import type { SpawnRequest } from "@/types";
import styles from "./TerminalWorkspace.module.css";

// 좌측 콘텐츠 + 우측 AI 터미널 drawer의 공통 작업 셸. 회의록 화면(WorkArea)과 회의 유형 화면이
// 동일한 레이아웃·리사이즈·접기 동작을 재사용한다. 좌측에 무엇을 보여줄지(children)와 drawer
// 상태(drawerOpen)·라벨·빈 상태만 호출자가 결정한다.
//
// TerminalPanel은 항상 마운트(언마운트하면 PTY 연결 끊김). collapsed 시 CSS로만 숨긴다.

const PANEL_WIDTH_MIN = 380;
const PANEL_WIDTH_MAX = 580;
const PANEL_WIDTH_DEFAULT = 460;
const PANEL_WIDTH_KEY = "app.workArea.panelWidth";

const clampWidth = (n: number) => Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, n));

function loadInitialPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_WIDTH_DEFAULT;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return PANEL_WIDTH_DEFAULT;
    return clampWidth(n);
  } catch {
    return PANEL_WIDTH_DEFAULT;
  }
}

interface TerminalWorkspaceProps {
  /** 좌측 콘텐츠 (회의록 viewer 또는 유형 관리 화면 등). */
  children: ReactNode;
  spawnRequest: SpawnRequest | null;
  onExit: () => void;
  onEscape?: () => void;
  /** drawer 펼침 여부 — 호출자가 진실 원천 (세션 컨텍스트 또는 화면 로컬 상태). */
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  panelLabel: string;
  /** 완료 상태 라벨(accent 색)로 표시할지. */
  panelDone?: boolean;
  /** spawnRequest 없을 때 drawer 본문에 표시할 빈 상태 UI (없으면 빈 패널). */
  emptyState?: ReactNode;
  /** AI 토글 버튼 노출 여부 (기본 true). 유형 화면처럼 작업 중에만 노출하고 싶을 때 false. */
  showToggle?: boolean;
}

export default function TerminalWorkspace({
  children,
  spawnRequest,
  onExit,
  onEscape,
  drawerOpen,
  onToggleDrawer,
  panelLabel,
  panelDone = false,
  emptyState,
  showToggle = true,
}: TerminalWorkspaceProps) {
  const [panelWidth, setPanelWidth] = useState<number>(loadInitialPanelWidth);
  const [isDragging, setIsDragging] = useState(false);

  // drawer collapsed → expanded 전환 시 TerminalPanel 자동 focus — display:none ↔ visible 전환 후
  // xterm.js textarea가 focus 받아야 사용자가 panel 클릭 없이 바로 입력 가능.
  const terminalRef = useRef<TerminalPanelHandle | null>(null);
  const prevDrawerOpenRef = useRef(drawerOpen);
  useEffect(() => {
    if (!prevDrawerOpenRef.current && drawerOpen) {
      requestAnimationFrame(() => terminalRef.current?.focus());
    }
    prevDrawerOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  const onResizeHandleDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panelWidth;
      setIsDragging(true);
      const prevBodyCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      let finalWidth = startWidth;
      const onMove = (ev: MouseEvent) => {
        // handle은 drawer 좌측 경계. 마우스가 왼쪽으로 가면 panel이 넓어짐.
        const dx = startX - ev.clientX;
        finalWidth = clampWidth(startWidth + dx);
        setPanelWidth(finalWidth);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = prevBodyCursor;
        document.body.style.userSelect = prevUserSelect;
        setIsDragging(false);
        try {
          localStorage.setItem(PANEL_WIDTH_KEY, String(finalWidth));
        } catch {}
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [panelWidth]
  );

  const workAreaStyle = { "--app-panel-width": `${panelWidth}px` } as CSSProperties;

  return (
    <div
      className={clsx(
        styles.workArea,
        drawerOpen && styles.drawerOpen,
        isDragging && styles.dragging
      )}
      style={workAreaStyle}
    >
      {showToggle && (
        <button
          type="button"
          className={styles.aiToggleBtn}
          onClick={onToggleDrawer}
          title={drawerOpen ? "AI 작업 패널 접기" : "AI 작업 패널 열기"}
          aria-label={drawerOpen ? "AI 작업 패널 접기" : "AI 작업 패널 열기"}
        >
          <svg
            width="22"
            height="16"
            viewBox="0 0 24 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect width="20" height="14" x="2" y="2" rx="2" />
            <rect
              x="15"
              y="2"
              width="5"
              height="14"
              fill="currentColor"
              stroke="none"
              opacity="0.15"
            />
            <path d="M15 2v14" />
          </svg>
        </button>
      )}

      <div className={styles.viewerArea}>{children}</div>

      <aside className={styles.drawerArea} aria-label="AI 작업 패널">
        <div
          className={styles.resizeHandle}
          onMouseDown={onResizeHandleDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="패널 너비 조절"
        />
        <div className={styles.panelHeader}>
          <span className={clsx(styles.panelLabel, panelDone && styles.panelLabelDone)}>
            {panelLabel}
          </span>
        </div>
        <div className={styles.panelBody}>
          <div className={clsx(styles.terminalWrap, !spawnRequest && styles.hidden)}>
            <TerminalPanel
              ref={terminalRef}
              spawnRequest={spawnRequest}
              onExit={onExit}
              onEscape={onEscape}
            />
          </div>
          {!spawnRequest && emptyState}
        </div>
      </aside>
    </div>
  );
}
