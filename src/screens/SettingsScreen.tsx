import { useEffect, useState } from "react";
import clsx from "clsx";
import { LOCAL_MODEL_HIGH } from "@/constants";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import { useSession } from "@/contexts/SessionContext";
import { resetAnalyticsGate } from "@/utils/analytics";
import { logError } from "@/utils/logging";
import type { Cli } from "@/types";
import styles from "./Settings.module.css";

const CLI_LABELS: Record<Cli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  mlx: "로컬 AI (Gemma)",
  antigravity: "Antigravity CLI",
};

// 앱 설정 화면 — 빈도 낮은 설정의 모음 자리. 자주 쓰는 콘텐츠 관리(용어 사전·회의 유형)는
// 사이드바 직접 항목으로, 한두 번 만지는 설정은 여기로 모은다.
// v1: AI 도구 변경. 추후 후보: codex 로그아웃 등.
export default function SettingsScreen() {
  const sidebarTarget = useSidebarTarget();
  const navigate = useNavigate();
  const { cli } = useSession();
  // 로컬 AI일 때 선택된 변형(표준/고품질)까지 표기 — 어떤 모델이 도는지 한눈에.
  const [localVariant, setLocalVariant] = useState<string>("");
  useEffect(() => {
    if (cli !== "mlx") return;
    invoke<string>("cmd_get_local_model")
      .then((m) => setLocalVariant(m === LOCAL_MODEL_HIGH ? " · 고품질" : " · 표준"))
      .catch(() => {});
  }, [cli]);

  // 진단·사용 통계 수집 동의 (기본 켜짐). 끄면 원격 전송이 앱 재시작 후 완전히 멈춘다.
  const [telemetryOn, setTelemetryOn] = useState(true);
  useEffect(() => {
    invoke<boolean>("cmd_get_telemetry_enabled")
      .then(setTelemetryOn)
      .catch(() => {});
  }, []);

  const toggleTelemetry = () => {
    const next = !telemetryOn;
    setTelemetryOn(next); // 낙관적 반영
    invoke<void>("cmd_set_telemetry_enabled", { on: next })
      .then(() => resetAnalyticsGate())
      .catch((e) => {
        logError("SettingsScreen.setTelemetry", e);
        setTelemetryOn(!next); // 실패 시 롤백
      });
  };

  const openLogDir = () => {
    invoke<void>("cmd_open_log_dir").catch((e) => logError("SettingsScreen.openLogDir", e));
  };

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <div className={styles.settingsMain}>
        <header className={styles.settingsHeader}>
          <h1 className={styles.settingsTitle}>설정</h1>
          <p className={styles.settingsDesc}>앱 동작 방식을 변경합니다.</p>
        </header>

        <section className={styles.settingsCard}>
          <div className={styles.settingsCardMeta}>
            <span className={styles.settingsCardLabel}>회의록 AI</span>
            <span className={styles.settingsCardDesc}>
              회의록 작성에 사용 중:{" "}
              <span className={styles.settingsCardValue}>
                {CLI_LABELS[cli]}
                {cli === "mlx" ? localVariant : ""}
              </span>
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/settings/ai-tool")}
          >
            변경
          </button>
        </section>

        <section className={styles.settingsCard}>
          <div className={styles.settingsCardMeta}>
            <span className={styles.settingsCardLabel}>시스템 권한</span>
            <span className={styles.settingsCardDesc}>
              마이크·시스템 오디오·캘린더 권한 확인·관리
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/settings/permissions")}
          >
            관리
          </button>
        </section>

        {/* 오픈소스 라이선스 고지 — 동봉 pyannote 모델(CC-BY-4.0) 등 서드파티 출처 표기.
            AI 도구와 같은 마스터-디테일 패턴으로 전용 화면에 모은다. */}
        <section className={styles.settingsCard}>
          <div className={styles.settingsCardMeta}>
            <span className={styles.settingsCardLabel}>오픈소스 라이선스</span>
            <span className={styles.settingsCardDesc}>
              앱이 사용하는 오픈소스 컴포넌트의 출처·라이선스
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/settings/licenses")}
          >
            보기
          </button>
        </section>

        <section className={styles.settingsCard}>
          <div className={styles.settingsCardMeta}>
            <span className={styles.settingsCardLabel}>앱 업데이트</span>
            <span className={styles.settingsCardDesc}>현재 버전 확인 · 새 버전 설치</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/settings/update")}
          >
            확인
          </button>
        </section>

        {/* 진단·사용 통계 — 오류 원인 파악과 기능 개선을 위한 익명 수집. 회의 내용은 절대 보내지 않음. */}
        <section className={clsx(styles.settingsCard, styles.settingsCardVertical)}>
          <div className={styles.settingsCardRow}>
            <div className={styles.settingsCardMeta}>
              <span className={styles.settingsCardLabel}>진단 및 사용 통계</span>
              <span className={styles.settingsCardDesc}>
                오류 원인 파악과 기능 개선에 쓰이는 익명 정보를 보냅니다.
              </span>
            </div>
            <button
              type="button"
              className={clsx(styles.settingsSwitch, telemetryOn && styles.active)}
              role="switch"
              aria-checked={telemetryOn}
              aria-label="진단 및 사용 통계 수집"
              onClick={toggleTelemetry}
            >
              <span className={styles.settingsSwitchKnob} aria-hidden="true" />
            </button>
          </div>

          <div className={styles.settingsCollectList}>
            <span>
              <strong>보내는 것.</strong> 오류·충돌 기록, 어떤 기능을 얼마나 썼는지(횟수·유형)
            </span>
            <span>
              <strong>보내지 않는 것.</strong> 녹음·전사·회의록·회의 제목 등 회의 내용 일체
            </span>
          </div>

          <div className={styles.settingsCardActions}>
            <button type="button" className="btn btn-secondary" onClick={openLogDir}>
              로그 폴더 열기
            </button>
            <span className={styles.settingsCardNote}>끄면 앱을 다시 켠 뒤 완전히 멈춰요.</span>
          </div>
        </section>
      </div>
    </>
  );
}
