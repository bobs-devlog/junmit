import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import styles from "./Header.module.css";

// 메인 영역 좌상단 navigation 헤더 — `<` 뒤로 + 화면 제목.
// 회의 화면(/recording, /session)에선 회의 제목이 inline editable.
//
// 클릭 시 navigate(-1) → router POP → 작업 중이면 useNavigationBlocker가 차단·confirm.
// Home("/")에서는 이전 entry가 사실상 없으니 disabled.
export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { meeting, updateTitle } = useSession();
  const isHome = location.pathname === "/";
  const isMeetingScreen = location.pathname === "/recording" || location.pathname === "/session";
  const title = getTitle(location.pathname, meeting?.title);
  const canEditTitle = isMeetingScreen && meeting != null;

  return (
    // data-tauri-drag-region — Header 빈 영역으로 윈도우 드래그.
    // 자식 button/title 등은 자동 드래그 제외 (interactive element는 Tauri가 알아서 처리).
    <div className={styles.header} data-tauri-drag-region>
      <button
        type="button"
        className={styles.backButton}
        onClick={() => navigate(-1)}
        disabled={isHome}
      >
        ← 뒤로
      </button>
      {title != null &&
        (canEditTitle ? (
          <EditableTitle title={title} onSave={updateTitle} />
        ) : (
          <span className={styles.title} data-tauri-drag-region>
            {title}
          </span>
        ))}
    </div>
  );
}

// `draft: string | null` 단일 state — null=조회 모드, 문자열=편집 모드 + 현재 입력값.
// editing flag + draft 두 state 분리 패턴 회피 (setState-in-effect 트리거).
function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const startEdit = () => setDraft(title);
  const cancel = () => setDraft(null);

  const commit = async () => {
    if (draft == null) return;
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      try {
        await onSave(trimmed);
      } catch {
        /* silent — 다음 시도에서 재시도 */
      }
    }
    setDraft(null);
  };

  // 편집 모드 진입 시 1회만 focus + select-all. ref callback으로 처리하면
  // 매 렌더마다 함수 인스턴스가 새로 생성되어 select가 매 키 입력마다 호출되고
  // 결과적으로 입력한 글자가 매번 전체 선택되어 한 글자만 남는 버그가 발생한다.
  // draft 값 전체가 아닌 "편집 중" 여부에만 의존시켜야 매 입력마다 트리거 안 됨.
  const editing = draft != null;
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (draft == null) {
    return (
      <span className={styles.editableTitle} title="클릭해서 제목 수정" onClick={startEdit}>
        {title}
        <svg
          className={styles.editIcon}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className={styles.titleInput}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}

function getTitle(pathname: string, meetingTitle: string | undefined): string | null {
  if (pathname === "/") return "새 회의";
  if (pathname === "/history") return "회의 기록";
  if (pathname === "/vocabulary") return "용어 사전";
  if (pathname === "/recording" || pathname === "/session") {
    return meetingTitle ?? null;
  }
  return null;
}
