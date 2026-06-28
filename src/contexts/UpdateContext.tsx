import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

// 앱 자동 업데이트 전역 상태 — 시작 시 1회 조용히 *확인만* 하고(설치는 안 함),
// 사이드바 pill과 "설정 > 앱 업데이트" 화면이 이 상태를 단일 원천으로 공유한다.
// 미서명·미공증 배포라 다운로드·설치·재실행은 항상 사용자 클릭으로만 진입(강제/자동 설치 없음).

interface UpdateApi {
  currentVersion: string;
  available: boolean;
  newVersion: string | null;
  notes: string | null;
  checking: boolean;
  installing: boolean;
  installed: boolean; // 설치는 끝났으나 자동 재실행이 안 된 상태(수동 재실행 필요)
  progress: number | null; // 0..1, 총 크기를 모르면 null
  recheck: () => Promise<boolean>; // 업데이트 발견 여부 반환
  install: () => Promise<void>;
}

const UpdateContext = createContext<UpdateApi | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [currentVersion, setCurrentVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // 주기적 재확인이 설치 중에 끼어들지 않도록 최신 installing 값을 ref로 추적.
  const installingRef = useRef(false);
  useEffect(() => {
    installingRef.current = installing;
  });

  // 업데이트 확인 — 시작 시 자동(조용히) + 설정 화면 "업데이트 확인" 버튼이 공유.
  // 네트워크 실패·릴리스 부재(404 등)면 조용히 "없음"으로 처리한다.
  const recheck = useCallback(async (): Promise<boolean> => {
    setChecking(true);
    try {
      const u = await check();
      setUpdate(u);
      return u !== null;
    } catch {
      setUpdate(null);
      return false;
    } finally {
      setChecking(false);
    }
  }, []);

  // 다운로드 + 설치 + 재실행. 항상 사용자 클릭으로만 호출된다.
  // /Applications 설치 시 macOS가 관리자 암호를 한 번 물을 수 있다.
  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    setProgress(0);
    let total = 0;
    let received = 0;
    // 1단계: 다운로드 + 설치. 여기서 실패하면 진짜 설치 실패라 호출자에게 throw.
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            received += event.data.chunkLength;
            setProgress(total > 0 ? received / total : null);
            break;
          case "Finished":
            setProgress(1);
            break;
        }
      });
    } catch (e) {
      setInstalling(false);
      setProgress(null);
      throw e;
    }
    // 2단계: 설치 성공. 재실행을 시도하되, 실패해도 설치는 이미 끝났으므로
    // throw하지 않고 "설치됨 — 수동 재실행 안내" 상태로 둔다(미서명 ad-hoc 환경에서
    // relaunch가 불안정하다는 보고가 있어 막다른 화면을 피한다).
    setInstalled(true);
    try {
      await relaunch(); // 성공 시 앱이 재시작되어 이 줄 이후로는 도달하지 않는다
    } catch {
      /* 재실행 실패 — installed=true가 UI에서 수동 재실행을 안내한다 */
    }
  }, [update]);

  // 현재 버전 표시 + 시작 시 1회 조용한 확인 + 주기적(6시간) 재확인.
  // 오래 켜두는 세션(회의 녹음 앱) 대비 — Sparkle 기본도 주기 확인(하루 1회)을 한다.
  // 설치 중에는 끼어들지 않는다(installingRef). recheck는 안정 참조.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch(() => {});
    void recheck();
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const id = setInterval(() => {
      if (!installingRef.current) void recheck();
    }, SIX_HOURS);
    return () => clearInterval(id);
  }, [recheck]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const value = useMemo<UpdateApi>(
    () => ({
      currentVersion,
      available: update !== null,
      newVersion: update?.version ?? null,
      notes: update?.body ?? null,
      checking,
      installing,
      installed,
      progress,
      recheck,
      install,
    }),
    [currentVersion, update, checking, installing, installed, progress, recheck, install]
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateApi {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within UpdateProvider");
  return ctx;
}
