import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "../Sidebar";
import Header from "../Header";
import styles from "@/App.module.css";

// Portal target — 화면 컴포넌트가 createPortal로 사이드바 콘텐츠를 주입.
// 셸은 라우트 밖(MainLayout)이라 화면 전환 시 mount 유지, 콘텐츠만 화면별 변경.
const SidebarTargetContext = createContext<HTMLElement | null>(null);

export function useSidebarTarget(): HTMLElement | null {
  return useContext(SidebarTargetContext);
}

// Layout Route element — Home/History/Session 화면 공통 셸 (Sidebar + 메인 영역).
// SetupScreen 등 fullscreen 라우트는 이 Layout 밖에 둔다.
export default function MainLayout(): ReactNode {
  const slotRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  // useLayoutEffect — DOM commit 후 paint 전에 동기 실행.
  // ref 콜백 useState 패턴은 첫 렌더에 target=null이라 portal 활성까지 한 프레임 지연되는데,
  // useLayoutEffect는 paint 전에 setTarget 처리 → 사용자 깜빡임 인지 X.
  useLayoutEffect(() => {
    setTarget(slotRef.current);
  }, []);

  return (
    <SidebarTargetContext.Provider value={target}>
      <div className={styles.app}>
        <Sidebar slotRef={slotRef} />
        <main className={styles.mainContent}>
          <Header />
          <div className={styles.contentBody}>
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarTargetContext.Provider>
  );
}
