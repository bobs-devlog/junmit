import { createPortal } from "react-dom";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import { useUpdate } from "@/contexts/UpdateContext";
import { useToast } from "@/contexts/ToastContext";
import styles from "./Settings.module.css";

// 설정 > 앱 업데이트 — 현재 버전 표시 + 수동 확인 + 설치(진행률).
// 자동 업데이트 상태는 UpdateContext가 단일 원천(사이드바 pill과 공유). 설치는
// 사용자가 직접 누를 때만 진행되고, 완료 시 앱이 자동 재시작된다(미서명이라
// /Applications 교체 시 macOS가 관리자 암호를 한 번 물을 수 있음 — 안내 문구).
export default function SettingsUpdateScreen() {
  const sidebarTarget = useSidebarTarget();
  const toast = useToast();
  const {
    currentVersion,
    available,
    newVersion,
    notes,
    checking,
    installing,
    installed,
    progress,
    recheck,
    install,
  } = useUpdate();

  const onCheck = async () => {
    const found = await recheck();
    if (!found) toast.info("이미 최신 버전입니다.");
  };

  const onInstall = async () => {
    try {
      await install();
      // 성공 시 relaunch로 앱이 재시작되어 이 줄엔 도달하지 않는다.
    } catch {
      toast.error("업데이트 설치에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  };

  const pct = progress === null ? null : Math.round(progress * 100);

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <div className={styles.settingsMain}>
        <header className={styles.settingsHeader}>
          <h1 className={styles.settingsTitle}>앱 업데이트</h1>
          <p className={styles.settingsDesc}>
            새 버전을 확인하고 설치합니다. 설치는 직접 누를 때만 진행됩니다.
          </p>
        </header>

        <section className={styles.settingsCard}>
          <div className={styles.settingsCardMeta}>
            <span className={styles.settingsCardLabel}>현재 버전</span>
            <span className={styles.settingsCardDesc}>
              <span className={styles.settingsCardValue}>{currentVersion || "—"}</span>
            </span>
          </div>
          {!available && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={checking}
              onClick={() => void onCheck()}
            >
              {checking ? "확인 중…" : "업데이트 확인"}
            </button>
          )}
        </section>

        {available && (
          <section className={styles.settingsCard}>
            <div className={styles.settingsCardMeta}>
              <span className={styles.settingsCardLabel}>✨ 새 버전 {newVersion}</span>
              <span className={styles.settingsCardDesc}>
                {installed
                  ? "설치 완료. 앱을 완전히 종료한 뒤 다시 열면 새 버전이 적용됩니다."
                  : installing
                    ? pct === null
                      ? "설치 중…"
                      : `설치 중… ${pct}%`
                    : "설치하면 앱이 자동으로 재시작됩니다. (macOS가 관리자 암호를 한 번 물을 수 있어요.)"}
              </span>
            </div>
            {!installed && (
              <button
                type="button"
                className="btn"
                disabled={installing}
                onClick={() => void onInstall()}
              >
                {installing ? "설치 중…" : "지금 설치"}
              </button>
            )}
          </section>
        )}

        {available && notes && !installing && (
          <section className={styles.settingsCard}>
            <div className={styles.settingsCardMeta}>
              <span className={styles.settingsCardLabel}>변경 사항</span>
              <span className={styles.settingsCardDesc} style={{ whiteSpace: "pre-wrap" }}>
                {notes}
              </span>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
