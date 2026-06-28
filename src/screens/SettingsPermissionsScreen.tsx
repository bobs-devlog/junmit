import { createPortal } from "react-dom";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import {
  MIC_PRIVACY_SETTINGS_URL,
  CALENDAR_PRIVACY_SETTINGS_URL,
  SYSTEM_AUDIO_PRIVACY_SETTINGS_URL,
  NOTIFICATION_SETTINGS_URL,
} from "@/constants";
import styles from "./Settings.module.css";

// 설정 > 시스템 권한 — 마이크·캘린더·알림 권한 상태를 표시하고 직접 조치.
// 마이크·캘린더는 FFI(cmd_check_*_permission), 알림은 plugin-notification으로 조회. 화면은
// 조회·표시 + 상태별 액션만 담당.
// 마운트 시 조회만 하고 자동으로 OS 다이얼로그를 띄우지 않는다(설정 화면은 표시가 본분 —
// 요청은 사용자가 버튼으로). MeetingSelector는 녹음 직전이라 권한을 자동 요청하는 것과 대비.

type PermStatus = "authorized" | "denied" | "restricted" | "not_determined" | "unknown";

const STATUS_META: Record<PermStatus, { label: string; badgeClass: string }> = {
  authorized: { label: "허용됨", badgeClass: styles.permBadgeOk },
  not_determined: { label: "미요청", badgeClass: styles.permBadgeNeutral },
  restricted: { label: "제한됨", badgeClass: styles.permBadgeWarn },
  denied: { label: "차단됨", badgeClass: styles.permBadgeDanger },
  unknown: { label: "확인 불가", badgeClass: styles.permBadgeNeutral },
};

interface PermissionCardProps {
  label: string;
  desc: string;
  status: PermStatus;
  // not_determined일 때 인앱 요청(OS 다이얼로그 트리거).
  onRequest: () => void;
  // denied/restricted일 때 시스템 설정 페이지 열기.
  onOpenSettings: () => void;
}

function PermissionCard({ label, desc, status, onRequest, onOpenSettings }: PermissionCardProps) {
  const meta = STATUS_META[status];
  return (
    <section className={styles.settingsCard}>
      <div className={styles.settingsCardMeta}>
        <span className={styles.settingsCardLabel}>{label}</span>
        <span className={styles.settingsCardDesc}>{desc}</span>
      </div>
      <div className={styles.permAction}>
        <span className={`${styles.permBadge} ${meta.badgeClass}`}>{meta.label}</span>
        {status === "not_determined" && (
          <button type="button" className="btn btn-secondary" onClick={onRequest}>
            요청
          </button>
        )}
        {(status === "denied" || status === "restricted") && (
          <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>
            시스템 설정 열기
          </button>
        )}
      </div>
    </section>
  );
}

export default function SettingsPermissionsScreen() {
  const sidebarTarget = useSidebarTarget();
  const [mic, setMic] = useState<PermStatus>("unknown");
  const [calendar, setCalendar] = useState<PermStatus>("unknown");
  const [systemAudio, setSystemAudio] = useState<PermStatus>("unknown");
  const [notif, setNotif] = useState<PermStatus>("unknown");

  // 권한 상태 재조회 — 마운트 + 각 액션 후 + "다시 확인" 버튼이 공유.
  // 알림은 plugin API가 boolean(isPermissionGranted)만 줘 미요청/차단을 못 가린다 → granted면 authorized,
  // 아니면 not_determined로 보되, 이미 차단(denied)이 한 번 드러났으면 그 상태를 보존(요청 시 확정됨).
  const refresh = useCallback(async () => {
    const [micStatus, calendarStatus, systemAudioStatus, notifGranted] = await Promise.all([
      invoke<string>("cmd_check_mic_permission").catch(() => "unknown"),
      invoke<string>("cmd_check_calendar_permission").catch(() => "unknown"),
      invoke<string>("cmd_check_system_audio_permission").catch(() => "unknown"),
      isPermissionGranted().catch(() => false),
    ]);
    setMic(micStatus as PermStatus);
    setCalendar(calendarStatus as PermStatus);
    setSystemAudio(systemAudioStatus as PermStatus);
    setNotif((prev) =>
      notifGranted ? "authorized" : prev === "denied" ? "denied" : "not_determined"
    );
  }, []);

  // 마운트 시 1회 조회 — refresh의 setState는 await 뒤(비동기)라 cascading 아님(SessionScreen과 동일 패턴).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void refresh();
  }, [refresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 마이크 요청 — cmd_request_mic_permission이 not_determined 시 Swift AVCaptureDevice로 OS 다이얼로그를
  // 띄우고 응답까지 대기 후 갱신된 상태를 반환한다(시스템 오디오·캘린더와 동일하게 네이티브 경로 — 브라우저
  // getUserMedia 미사용). 이미 결정된 상태면 다이얼로그 없이 현재 상태를 돌려준다.
  const requestMic = useCallback(async () => {
    const status = await invoke<string>("cmd_request_mic_permission").catch(() => null);
    if (status) setMic(status as PermStatus);
    else await refresh();
  }, [refresh]);

  // 캘린더 요청 — cmd_fetch_calendar가 not_determined 시 Swift에서 OS 다이얼로그를 띄운다.
  // 반환되는 이벤트는 버리고(권한 트리거 목적) 상태만 재조회.
  const requestCalendar = useCallback(async () => {
    await invoke("cmd_fetch_calendar").catch(() => {});
    await refresh();
  }, [refresh]);

  // 시스템 오디오 요청 — cmd_request가 not_determined 시 Swift TCC SPI로 OS 다이얼로그를 띄우고
  // 응답까지 대기 후 갱신된 상태를 반환한다(마이크처럼 스트림 트리거가 아니라 직접 결과를 받음).
  const requestSystemAudio = useCallback(async () => {
    const status = await invoke<string>("cmd_request_system_audio_permission").catch(() => null);
    if (status) setSystemAudio(status as PermStatus);
    else await refresh();
  }, [refresh]);

  // 알림 요청 — requestPermission()이 tri-state를 반환하므로 차단(denied)도 여기서 확정된다.
  // (default = 다이얼로그 닫힘/미결정 → not_determined 유지)
  const requestNotif = useCallback(async () => {
    try {
      const perm = await requestPermission();
      setNotif(perm === "granted" ? "authorized" : perm === "denied" ? "denied" : "not_determined");
    } catch {
      await refresh();
    }
  }, [refresh]);

  const openSettings = (url: string) => {
    invoke("cmd_open_path", { path: url }).catch(() => {});
  };

  const blocked =
    mic === "denied" ||
    mic === "restricted" ||
    calendar === "denied" ||
    calendar === "restricted" ||
    systemAudio === "denied" ||
    systemAudio === "restricted";

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <div className={styles.settingsMain}>
        <header className={styles.settingsHeader}>
          <h1 className={styles.settingsTitle}>시스템 권한</h1>
          <p className={styles.settingsDesc}>
            Junmit이 회의 녹음·일정 연동에 사용하는 macOS 권한입니다.
          </p>
        </header>

        <PermissionCard
          label="🎤 마이크"
          desc="회의 녹음에 필요합니다."
          status={mic}
          onRequest={() => void requestMic()}
          onOpenSettings={() => openSettings(MIC_PRIVACY_SETTINGS_URL)}
        />
        <PermissionCard
          label="🔊 시스템 오디오"
          desc="원격회의 상대방 음성을 함께 녹음하는 데 사용합니다. 화면은 보지 않습니다 (선택)."
          status={systemAudio}
          onRequest={() => void requestSystemAudio()}
          onOpenSettings={() => openSettings(SYSTEM_AUDIO_PRIVACY_SETTINGS_URL)}
        />
        <PermissionCard
          label="📅 캘린더"
          desc="오늘의 일정을 불러와 회의를 선택하는 데 사용합니다 (선택)."
          status={calendar}
          onRequest={() => void requestCalendar()}
          onOpenSettings={() => openSettings(CALENDAR_PRIVACY_SETTINGS_URL)}
        />
        <PermissionCard
          label="🔔 알림"
          desc="전사 완료·실패 등을 macOS 알림으로 알려줍니다 (선택)."
          status={notif}
          onRequest={() => void requestNotif()}
          onOpenSettings={() => openSettings(NOTIFICATION_SETTINGS_URL)}
        />

        <div className={styles.permFooter}>
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
            다시 확인
          </button>
          {blocked && (
            <span className={styles.settingsCardDesc}>
              시스템 설정에서 권한을 바꾼 뒤에는 앱을 재시작해야 반영될 수 있습니다.
            </span>
          )}
        </div>
      </div>
    </>
  );
}
