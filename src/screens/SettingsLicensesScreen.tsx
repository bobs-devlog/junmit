import { createPortal } from "react-dom";
import { useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import licenseText from "../../THIRD_PARTY_LICENSES.md?raw";
import styles from "./Settings.module.css";

// 설정 > 오픈소스 라이선스 — THIRD_PARTY_LICENSES.md를 단일 진실 원천으로 그대로 렌더링한다.
// 이 파일은 생성물(scripts/licenses/regen.sh)이며 ?raw로 앱 번들에 inline되어, .dmg만 받은
// 사용자도 오프라인에서 전체 고지에 접근할 수 있다(MIT/Apache의 "배포물 동반" 요건 충족).
const REMARK_PLUGINS = [remarkGfm];

// 마크다운 anchor 클릭 시 webview 내 navigate를 막고 OS 기본 앱(브라우저)에 위임.
// NotesMarkdownView와 동일 패턴(cmd_open_path는 macOS `open`으로 URL·경로 모두 처리).
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          invoke("cmd_open_path", { path: href }).catch(() => {});
        }
      }}
    >
      {children}
    </a>
  ),
};

// 문서 상단(주요 컴포넌트 요약)과 전체 의존성 전문(cargo·npm 덤프)의 경계.
// regen.sh가 항상 이 헤딩을 먼저 출력하므로 안정적이며, 못 찾으면 전체를 요약으로 간주(graceful).
const FULL_MARKER = "\n## Rust 의존성 (cargo)";

// 화면 자체에 h1이 있으므로 문서 최상단 제목(h1)은 제거해 중복을 피한다.
const body = licenseText.replace(/^#[^\n]*\n+/, "");
const splitAt = body.indexOf(FULL_MARKER);
const summaryMd = splitAt >= 0 ? body.slice(0, splitAt) : body;
const fullMd = splitAt >= 0 ? body.slice(splitAt + 1) : "";

export default function SettingsLicensesScreen() {
  const sidebarTarget = useSidebarTarget();
  const [showFull, setShowFull] = useState(false);

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <div className={styles.settingsMain}>
        <header className={styles.settingsHeader}>
          <h1 className={styles.settingsTitle}>오픈소스 라이선스</h1>
        </header>

        <div className={styles.licenseDoc}>
          <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {summaryMd}
          </Markdown>
        </div>

        {fullMd && (
          <>
            <button
              type="button"
              className={`btn btn-secondary ${styles.licenseToggle}`}
              aria-expanded={showFull}
              onClick={() => setShowFull((v) => !v)}
            >
              {showFull ? "전체 라이선스 전문 접기" : "전체 라이선스 전문 보기"}
            </button>
            {showFull && (
              <div className={styles.licenseDoc}>
                <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
                  {fullMd}
                </Markdown>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
