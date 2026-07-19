import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import type { CliOption } from "./cliOptions";
import styles from "./CliSelector.module.css";

interface AgentCliSetupProps {
  option: CliOption;
  installed: boolean;
  needsLogin: boolean;
  ready: boolean;
  busy: boolean;
  detecting: boolean;
  // 이 CLI의 로그인 도우미가 우측 터미널에 떠 있는지 — 진행 중 안내(브라우저 복귀 배너·
  // agy 폴링 문구) 분기. stale 판별(타 CLI 도우미 잔존)은 부모가 helper의 cli/kind로 계산.
  loginHelperActive: boolean;
  // agy 로그인 폴링의 "지금 확인 중" 순간 표시 — 스피너 노출 여부(부모 폴링 effect가 관리).
  loginChecking: boolean;
  onInstall: () => void;
  onLogin: () => void;
  onBack: () => void;
  onProceed: () => void;
  onRedetect: () => void;
}

// 2단계(에이전트 CLI): 설치 → 로그인 → 준비 완료. 감지·도우미 실행·진행 라우팅은 부모
// (CliSelector) 소유 — 여기는 상태별 안내와 버튼 전달만.
export default function AgentCliSetup({
  option,
  installed,
  needsLogin,
  ready,
  busy,
  detecting,
  loginHelperActive,
  loginChecking,
  onInstall,
  onLogin,
  onBack,
  onProceed,
  onRedetect,
}: AgentCliSetupProps) {
  // 시스템 기본 브라우저로 외부 링크 열기(설치 실패 시 공식 가이드).
  const openExternal = (url: string) => {
    invoke("plugin:shell|open", { path: url }).catch(() => {});
  };

  return (
    <>
      <p className={styles.selectSubtitle}>
        {option.name}를 준비할게요. 설치하고 로그인하면 바로 시작됩니다.
      </p>

      {!installed ? (
        <div className={styles.install}>
          <button type="button" className="btn btn-primary btn-small" onClick={onInstall}>
            설치하기
          </button>
          <div className={styles.installLabel}>
            공식 인스톨러를 우측 터미널에서 실행 · 끝나면 자동 확인 (brew·node 불필요)
          </div>
          <button
            type="button"
            className={styles.link}
            onClick={() => openExternal(option.docsUrl)}
          >
            설치가 안 되면 공식 가이드 →
          </button>
        </div>
      ) : needsLogin ? (
        <div className={styles.install}>
          <button type="button" className="btn btn-primary btn-small" onClick={onLogin}>
            {/* claude/codex는 클릭 즉시 기본 브라우저가 열린다 — 버튼 자체가 그걸
                예고해 갑작스러운 브라우저 전환의 혼란을 줄인다(사전 알럿 대체).
                agy는 TUI 마법사가 먼저라 브라우저 시점을 약속하지 않는다. */}
            {option.id === "antigravity" ? "로그인하기" : "브라우저로 로그인하기"}
          </button>
          <div className={styles.installLabel}>
            {option.id === "antigravity" ? (
              // agy는 로그인 명령이 없어 TUI 첫 실행이 로그인 흐름인데, 세부 절차
              // (인증 토큰 붙여넣기·최초 설정 마법사 등)는 버전마다 바뀔 수 있는
              // 프리뷰 제품이라 여기서 중계하지 않고 agy 자체 안내에 위임한다.
              // 종료 조작은 요구하지 않는다 — 부모의 폴링 effect가 확인을 대신하며,
              // "닫아라" 안내는 /logout 오입력 사고(계정 로그아웃)를 유발했다(실측).
              <>
                우측 터미널에 {option.name}가 뜹니다. 화면의 안내에 따라 로그인과 초기 설정을
                마쳐주세요.
                <br />
                {/* 전역 설정 수정 고지 — claude/codex의 "전용 환경" 고지와 대칭.
                    agy는 격리 환경이 없어 사용자 전역 설정에 항목을 추가하므로 알린다. */}
                회의록 작성에 필요한 설정(작업 폴더 신뢰)은 Junmit이 {option.name} 설정에 자동
                등록합니다.
                <br />
                {loginHelperActive ? (
                  // 폴링 표시 — 상시 문구 대신 실제 확인이 도는 순간에만 스피너를
                  // 잠깐 노출(loginChecking, 최소 600ms 보장). 자리는 visibility로
                  // 유지해 레이아웃이 점프하지 않는다.
                  <>
                    로그인이 확인되면 이 화면이 자동으로 바뀝니다. 터미널은 닫지 않아도 됩니다.
                    <br />
                    <span
                      className={clsx(styles.pollStatus, loginChecking && styles.pollStatusActive)}
                    >
                      <span className={styles.pollSpinner} aria-hidden="true" />
                      로그인 상태를 확인하는 중…
                    </span>
                  </>
                ) : (
                  <>로그인이 확인되면 이 화면이 자동으로 바뀝니다. 터미널은 닫지 않아도 됩니다.</>
                )}
              </>
            ) : loginHelperActive ? (
              // 로그인 진행 중 — 브라우저에 화면을 뺏겼다 돌아온 사용자가 처음 보는
              // 안내가 이 문구다(업계 관례의 "브라우저에서 계속" 대기 상태).
              // 스피너는 두지 않는다: claude/codex는 폴링이 아니라 명령 종료
              // (pty:exit) 시점 감지라 "확인 중" 시늉이 거짓이 된다(agy 폴링과 다름).
              <>
                <span className={styles.loginProgress}>
                  🌐 브라우저에 로그인 화면이 열렸어요. 로그인을 마치고 이 앱으로 돌아오면 자동으로
                  확인됩니다.
                </span>
                브라우저가 열리지 않았다면 위 버튼을 다시 눌러주세요.
              </>
            ) : (
              <>
                우측 터미널에서 <code className={styles.installCmd}>{option.loginCmdLabel}</code>{" "}
                실행 · 브라우저로 로그인하면 자동 확인
                <br />
                Junmit 전용 환경에 로그인합니다. 개인 {option.name} 설정·기록과 분리되어 있어, 이미
                로그인하셨더라도 1회 더 필요합니다.
              </>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.ready}>
          준비 완료. {option.name}로 시작할 수 있어요.
          {option.id === "antigravity" && (
            // 이미 로그인된 사용자는 로그인 화면(위 고지)을 안 거치므로 여기서 고지.
            <>
              {" "}
              회의록 작성에 필요한 설정(작업 폴더 신뢰)은 Junmit이 {option.name} 설정에 자동
              등록합니다.
            </>
          )}
        </div>
      )}

      <div className={styles.actions}>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          뒤로
        </button>
        {ready ? (
          <button
            type="button"
            className={clsx("btn btn-primary", busy && styles.btnDisabled)}
            aria-disabled={busy}
            onClick={onProceed}
            // 준비 완료로 전환되며 새로 마운트될 때 포커스를 받아, 자동 내비게이션의
            // 위험(flaky 감지에 끌려감) 없이 Enter 한 번으로 진행 가능하게 한다.
            autoFocus
          >
            {option.name}로 시작
          </button>
        ) : (
          <button
            type="button"
            className={clsx("btn btn-secondary", detecting && styles.btnDisabled)}
            onClick={onRedetect}
            aria-disabled={detecting}
          >
            다시 확인
          </button>
        )}
      </div>
    </>
  );
}
