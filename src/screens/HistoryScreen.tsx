import { useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import SessionList from "@/components/SessionList";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import { useSession } from "@/contexts/SessionContext";
import type { Session } from "@/types";

// 회의 기록 목록 → 카드 클릭 → /session 진입 (idle 상태로).
// 뒤로가기는 메인 영역 상단 Header `< 뒤로` (router 단일 진입점).
export default function HistoryScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const sidebarTarget = useSidebarTarget();

  const handleSessionSelect = useCallback(
    (s: Session) => {
      session.openExistingMeeting(s);
      navigate("/session");
    },
    [navigate, session]
  );

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <SessionList onSelect={handleSessionSelect} />
    </>
  );
}
