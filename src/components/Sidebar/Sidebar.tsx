import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useUpdate } from "@/contexts/UpdateContext";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  // MainLayout이 portal target ref를 전달. 화면이 createPortal로 콘텐츠 주입.
  slotRef: RefObject<HTMLDivElement | null>;
}

// Sidebar 셸 — 화면 전환 시 mount 유지. 화면별 콘텐츠(내비·컨트롤·회의 메타)는 전부
// 화면 컴포넌트가 portal로 주입한다. 셸은 route를 모르므로 어떤 화면 상태도 잔존시키지 않는다.
// 책임: 로고 + (업데이트 가능 시) 업데이트 pill + Portal slot.
export default function Sidebar({ slotRef }: SidebarProps) {
  const navigate = useNavigate();
  // 전역 업데이트 상태(UpdateContext) — 시작 시 조용히 확인된 결과. 있을 때만 pill 노출.
  const { available } = useUpdate();

  return (
    // data-tauri-drag-region — titleBarStyle: Overlay 환경에서 사이드바 빈 영역으로 윈도우 드래그.
    // 자식 button/input 등 interactive element는 Tauri가 자동으로 드래그 제외.
    <aside className={styles.sidebar} data-tauri-drag-region>
      <div className={styles.logo} data-tauri-drag-region>
        <h1 data-tauri-drag-region>Junmit</h1>
        <span className={styles.subtitle} data-tauri-drag-region>
          회의록 자동화
        </span>
        {available && (
          <button
            type="button"
            className={styles.updatePill}
            onClick={() => navigate("/settings/update")}
          >
            <span aria-hidden>↑</span> 업데이트 가능
          </button>
        )}
      </div>

      {/* 화면이 portal로 주입할 컨트롤·stepper·회의 메타 등의 영역 */}
      <div ref={slotRef} className={styles.slot} />
    </aside>
  );
}
