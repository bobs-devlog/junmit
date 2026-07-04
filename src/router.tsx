import { createMemoryRouter } from "react-router-dom";
import AppShell from "@/screens/AppShell";
import LoadingScreen from "@/screens/LoadingScreen";
import ErrorScreen from "@/screens/ErrorScreen";
import SetupScreen from "@/screens/SetupScreen";
import SelectCliScreen from "@/screens/SelectCliScreen/SelectCliScreen";
import HomeScreen from "@/screens/HomeScreen";
import HistoryScreen from "@/screens/HistoryScreen";
import RecordingScreen from "@/screens/RecordingScreen";
import SessionScreen from "@/screens/SessionScreen";
import VocabularyScreen from "@/screens/VocabularyScreen";
import MeetingTypesListScreen from "@/screens/MeetingTypesListScreen";
import MeetingTypeCreateScreen from "@/screens/MeetingTypeCreateScreen";
import MeetingTypeDetailScreen from "@/screens/MeetingTypeDetailScreen";
import SettingsScreen from "@/screens/SettingsScreen";
import SettingsAiToolScreen from "@/screens/SettingsAiToolScreen";
import SettingsLicensesScreen from "@/screens/SettingsLicensesScreen";
import SettingsPermissionsScreen from "@/screens/SettingsPermissionsScreen";
import SettingsUpdateScreen from "@/screens/SettingsUpdateScreen";
import MainLayout from "@/components/MainLayout";

// Module-level router. 데이터 라우터(createMemoryRouter + RouterProvider)라야
// useBlocker 등 v7 hook이 동작. instance가 stable해야 StrictMode 이중 마운트에 안전.
export const router = createMemoryRouter(
  [
    {
      // root layout — 글로벌 listener·init·exit modal 책임. Outlet 자식 routes 렌더.
      element: <AppShell />,
      children: [
        { path: "/loading", element: <LoadingScreen /> },
        { path: "/error", element: <ErrorScreen /> },
        { path: "/select-cli", element: <SelectCliScreen /> },
        // key 필수 — 같은 컴포넌트를 두 라우트가 공유하므로, key가 없으면 /setup(완료 상태)에서
        // /local-model로 넘어갈 때 React가 상태를 유지한 채 재사용해 설치도 안 한 모델이
        // "준비되었습니다"로 뜬다 (step state 잔존). key로 라우트별 강제 리마운트.
        { path: "/setup", element: <SetupScreen key="base" /> },
        { path: "/local-model", element: <SetupScreen key="model" mode="model" /> },
        {
          // Sidebar + 메인 영역 셸. Home/History/Recording/Session 공통.
          element: <MainLayout />,
          children: [
            { path: "/", element: <HomeScreen /> },
            { path: "/history", element: <HistoryScreen /> },
            { path: "/recording", element: <RecordingScreen /> },
            { path: "/session", element: <SessionScreen /> },
            { path: "/vocabulary", element: <VocabularyScreen /> },
            { path: "/meeting-types", element: <MeetingTypesListScreen /> },
            { path: "/meeting-types/new", element: <MeetingTypeCreateScreen /> },
            { path: "/meeting-types/:id", element: <MeetingTypeDetailScreen /> },
            { path: "/settings", element: <SettingsScreen /> },
            { path: "/settings/ai-tool", element: <SettingsAiToolScreen /> },
            { path: "/settings/permissions", element: <SettingsPermissionsScreen /> },
            { path: "/settings/update", element: <SettingsUpdateScreen /> },
            { path: "/settings/licenses", element: <SettingsLicensesScreen /> },
          ],
        },
      ],
    },
  ],
  { initialEntries: ["/loading"] }
);
