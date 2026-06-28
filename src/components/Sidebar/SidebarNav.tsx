import clsx from "clsx";
import { useLocation, useNavigate } from "react-router-dom";
import styles from "./Sidebar.module.css";

// idle 화면(새 회의·회의 기록·용어 사전) 공통 사이드바 내비.
// 녹음/전사/회의록 작성(프로세스) 화면은 집중 모드라 이 내비를 쓰지 않는다(각자 *SidebarControls).
//
// 고정 메뉴 — 항목 위치·순서가 항상 같다. 현재 화면 항목은 은은히 활성 표시(비클릭).
// 현재 화면 이름은 Header가 표시하므로 별도 타이틀 라벨은 두지 않는다.
const NAV_ITEMS = [
  { path: "/", label: "새 회의", icon: "📅" },
  { path: "/history", label: "회의 기록", icon: "🕘" },
  { path: "/vocabulary", label: "용어 사전", icon: "📖" },
  { path: "/meeting-types", label: "회의 유형", icon: "🗂" },
  { path: "/settings", label: "설정", icon: "⚙️" },
] as const;

export default function SidebarNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className={styles.controls}>
      {NAV_ITEMS.map((item) => {
        const active = item.path === pathname;
        return (
          <button
            key={item.path}
            className={active ? clsx("btn", styles.navItemActive) : "btn btn-secondary"}
            onClick={() => !active && navigate(item.path)}
            aria-current={active ? "page" : undefined}
          >
            <span className="btn-icon">{item.icon}</span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
