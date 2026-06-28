import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ReminderWindow from "./screens/ReminderWindow";
import { ToastProvider } from "./contexts/ToastContext";
import { DialogProvider } from "./contexts/DialogContext";
import { UpdateProvider } from "./contexts/UpdateContext";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

// 동일 HTML 번들을 reminder 보조 윈도우도 로드한다 — `?w=reminder`로 분기해
// 메인 앱 Provider들을 통과하지 않은 가벼운 트리만 마운트.
// CSS 격리: reminderWindow.css는 body.reminder-mode 스코프 안에서만 적용되어 메인에 영향 없음.
const isReminderWindow = new URLSearchParams(window.location.search).get("w") === "reminder";

if (isReminderWindow) {
  // html·body 모두에 클래스 부여 — styles.css가 html에도 var(--bg-primary)를 칠하므로
  // reminderWindow.css가 html까지 투명으로 덮어야 라운드 카드 바깥이 진짜 투명해진다.
  document.documentElement.classList.add("reminder-mode");
  document.body.classList.add("reminder-mode");
}

createRoot(rootEl).render(
  <StrictMode>
    {isReminderWindow ? (
      <ReminderWindow />
    ) : (
      <ToastProvider>
        <DialogProvider>
          <UpdateProvider>
            <App />
          </UpdateProvider>
        </DialogProvider>
      </ToastProvider>
    )}
  </StrictMode>
);
