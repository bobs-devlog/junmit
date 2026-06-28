import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { SessionProvider } from "./contexts/SessionContext";
import { RecorderProvider } from "./contexts/RecorderContext";

// Provider 셸만 책임. 라우트 정의는 router.tsx, 글로벌 listener·init은 AppShell.
// Provider 순서: Recorder → Session → Router. Recorder/Session은 router 안의 모든 화면이 사용.
export default function App() {
  return (
    <RecorderProvider>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </RecorderProvider>
  );
}
