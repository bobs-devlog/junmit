import CliSelector from "@/components/CliSelector/CliSelector";
import appStyles from "@/App.module.css";

// 온보딩 게이트(전체 화면, 사이드바 없음) — AppShell이 CLI 미선택 시 이 화면으로 보낸다.
// 선택·설치·로그인 로직은 CliSelector 소유 — 설정의 AI 도구 페이지(SettingsAiToolScreen)와 공유.
export default function SelectCliScreen() {
  return (
    <div className={appStyles.app}>
      <CliSelector title="Junmit" dragRegion />
    </div>
  );
}
