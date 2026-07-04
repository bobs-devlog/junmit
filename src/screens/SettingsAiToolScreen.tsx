import { createPortal } from "react-dom";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import CliSelector from "@/components/CliSelector/CliSelector";

// 설정 > 회의록 AI — 사이드바·레이아웃을 유지한 채 백엔드 선택을 제공한다.
// 온보딩 게이트(SelectCliScreen)와 같은 CliSelector를 공유하고, 껍데기만 다르다.
// 별도 돌아가기 버튼은 없음 — 사이드바가 유지되므로 내비는 사이드바로 충분.
export default function SettingsAiToolScreen() {
  const sidebarTarget = useSidebarTarget();

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <CliSelector title="회의록 AI" />
    </>
  );
}
