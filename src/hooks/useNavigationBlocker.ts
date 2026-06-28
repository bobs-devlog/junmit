import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { useDialog } from "@/contexts/DialogContext";
import type { ConfirmOptions } from "@/types";

export interface NavigationBlockerOptions {
  // 현재 차단해야 하는지. activity 등 화면 상태로 결정.
  shouldBlock: () => boolean;
  // 차단 시 사용자에게 띄울 confirm 다이얼로그 메시지.
  confirm: ConfirmOptions;
  // 사용자가 OK 누른 후 화면 자체의 cleanup (recorder.abort / cmd_pty_kill 등).
  // resetSession() 호출은 hook이 cleanup 후 자동 실행하니 여기서 하지 않는다.
  cleanup: () => void | Promise<void>;
}

// 라우터 history navigation(POP — 헤더 < 버튼·트랙패드 swipe·메뉴바 "이전" 등)에서만 차단.
// 화면 컴포넌트 내부 명시 navigate(PUSH/REPLACE)는 통과 — 사용자 의도가 명확하니
// 이미 cleanup·resetSession 후 navigate하거나 idle 상태에서 호출됨.
//
// 호출 화면이 자기 shouldBlock·confirm 메시지·cleanup을 주입한다. hook은:
//   1. POP + shouldBlock=true → confirm 다이얼로그
//   2. OK → cleanup() → resetSession() → blocker.proceed()
//   3. Cancel → blocker.reset()
//
// 데이터 라우터(createMemoryRouter + RouterProvider) 환경에서만 동작 — Step 0에서 마이그됨.
export default function useNavigationBlocker(options: NavigationBlockerOptions): void {
  const { resetSession } = useSession();
  const { confirm } = useDialog();

  // options ref — useBlocker callback·effect가 매 렌더 새 함수 identity여도 항상 최신값 참조.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const blocker = useBlocker(({ historyAction }) => {
    if (historyAction !== "POP") return false;
    return optionsRef.current.shouldBlock();
  });

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let cancelled = false;
    (async () => {
      const ok = await confirm(optionsRef.current.confirm);
      if (cancelled) return;
      if (!ok) {
        blocker.reset?.();
        return;
      }
      try {
        await optionsRef.current.cleanup();
      } catch {}
      resetSession();
      blocker.proceed?.();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker]);
}
