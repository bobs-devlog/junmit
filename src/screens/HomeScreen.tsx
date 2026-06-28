import { useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import MeetingSelector from "@/components/MeetingSelector";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import { useSession } from "@/contexts/SessionContext";
import type { Meeting } from "@/types";

// 새 회의 선택/입력 → /recording으로 navigate. recorder.start는 RecordingScreen이 책임 (책임 분리).
export default function HomeScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const sidebarTarget = useSidebarTarget();

  const handleMeetingSelect = useCallback(
    (selected: Meeting) => {
      session.startNewMeeting(selected);
      navigate("/recording");
    },
    [navigate, session]
  );

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <MeetingSelector onSelect={handleMeetingSelect} />
    </>
  );
}
