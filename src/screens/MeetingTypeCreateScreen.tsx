import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useBlocker } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import TerminalWorkspace from "@/components/TerminalWorkspace";
import TypeViewer from "@/components/TypeViewer";
import { useDialog } from "@/contexts/DialogContext";
import { useTemplateSession } from "@/hooks/useTemplateSession";
import { killPty } from "@/utils/pty";
import type { MeetingTypeOption } from "@/types";
import styles from "./MeetingTypes.module.css";

// 새 유형 만들기 (생성). 폼 입력 → AI 대화 생성 → 미리보기 → 저장. 저장/취소 시 목록으로.
export default function MeetingTypeCreateScreen() {
  const navigate = useNavigate();
  const sidebarTarget = useSidebarTarget();
  const { confirm } = useDialog();
  const session = useTemplateSession();

  const [existing, setExisting] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [output, setOutput] = useState("");

  useEffect(() => {
    let alive = true;
    invoke<MeetingTypeOption[]>("cmd_list_meeting_types")
      .then((t) => alive && setExisting(t.map((x) => x.id)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(() => {
    if (!name.trim() || !about.trim()) return;
    session.launchCreate({
      name: name.trim(),
      about: about.trim(),
      output: output.trim(),
      existing,
    });
  }, [name, about, output, existing, session]);

  // 저장/취소 같은 "명시적 이탈"은 이미 사용자가 결정한 것이라 leave-confirm을 띄우지 않는다
  // (이 ref가 true면 blocker가 통과). 컨펌은 사이드바 등 무심코 나가는 경우에만.
  const leavingRef = useRef(false);

  const onSave = useCallback(async () => {
    if (await session.save(name.trim())) {
      leavingRef.current = true;
      navigate("/meeting-types");
    }
  }, [session, name, navigate]);

  const onCancel = useCallback(async () => {
    // 만든 초안이 있으면(committable) 버리기 전에 확인. 아직 생성 전(중단)이면 즉시 나감.
    if (session.committable) {
      const ok = await confirm({
        title: "만든 내용을 버릴까요?",
        body: "저장하지 않으면 만들던 회의 유형이 사라집니다.",
        confirmLabel: "버리고 나가기",
        cancelLabel: "계속 만들기",
        danger: true,
      });
      if (!ok) return;
    }
    leavingRef.current = true;
    session.cancel();
    navigate("/meeting-types");
  }, [session, confirm, navigate]);

  // 작성/생성 중 *무심코* 화면 이탈 시 컨펌 (명시적 저장/취소는 leavingRef로 통과).
  const blocker = useBlocker(
    useCallback(() => session.active && !leavingRef.current, [session.active])
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({
      title: "저장하지 않고 나갈까요?",
      body: "지금 나가면 만들던 회의 유형이 저장되지 않습니다.",
      confirmLabel: "나가기",
      cancelLabel: "계속 편집",
      danger: true,
    }).then((ok) => {
      if (ok) {
        invoke("cmd_clear_staged_meeting_type").catch(() => {});
        void killPty();
        blocker.proceed?.();
      } else {
        blocker.reset?.();
      }
    });
  }, [blocker, confirm]);

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <TerminalWorkspace
        spawnRequest={session.spawnRequest}
        onExit={session.onPtyExit}
        drawerOpen={session.spawnRequest != null && !session.terminalCollapsed}
        onToggleDrawer={session.toggleTerminal}
        panelLabel="AI 작업"
        showToggle={session.spawnRequest != null}
      >
        <div className={styles.mtMain}>
          {/* 입력 폼 */}
          {session.phase === "idle" && (
            <section className={styles.mtForm}>
              <h2 className={styles.mtFormTitle}>새 유형 만들기</h2>
              <p className={styles.mtFormHint}>
                팀에 맞는 회의 유형을 자연어로 설명해주세요. AI가 회의 종류를 파악해 알맞은 구조를
                보강한 가이드를 만들고, 결과는 저장 전에 미리 확인·대화로 다듬을 수 있어요.
              </p>
              <label className={styles.mtField}>
                <span className={styles.mtFieldLabel}>유형 이름</span>
                <input
                  className={styles.mtInput}
                  type="text"
                  value={name}
                  placeholder="예: 회고, 1on1, 킥오프"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className={styles.mtField}>
                <span className={styles.mtFieldLabel}>이 회의는 어떤 회의인가요?</span>
                <textarea
                  className={styles.mtTextarea}
                  value={about}
                  rows={4}
                  placeholder="예: 스프린트가 끝나면 팀이 모여 잘된 점·아쉬운 점을 돌아가며 이야기하고, 다음 스프린트 개선점을 정리해요. 정해진 발표 자료는 없고 다 같이 자유롭게 말해요."
                  onChange={(e) => setAbout(e.target.value)}
                />
              </label>
              <label className={styles.mtField}>
                <span className={styles.mtFieldLabel}>회의록에 꼭 담겼으면 하는 것 (선택)</span>
                <textarea
                  className={styles.mtTextarea}
                  value={output}
                  rows={2}
                  placeholder="예: 개선 액션과 담당자, 칭찬할 점. (비워두면 AI가 알아서 구성해요)"
                  onChange={(e) => setOutput(e.target.value)}
                />
              </label>
              <div className={styles.mtActions}>
                <button
                  type="button"
                  className={styles.mtPrimary}
                  onClick={submit}
                  aria-disabled={!name.trim() || !about.trim()}
                >
                  AI로 만들기
                </button>
                <button
                  type="button"
                  className={styles.mtGhost}
                  onClick={() => navigate("/meeting-types")}
                >
                  취소
                </button>
              </div>
            </section>
          )}

          {/* 생성 중 — 편집 폼 대신 진행 안내. AI가 되물으면 오른쪽 터미널에서 답하도록 유도. */}
          {session.phase === "generating" && (
            <section className={styles.mtForm}>
              <h2 className={styles.mtFormTitle}>가이드 작성 중…</h2>
              <p className={styles.mtFormHint}>
                AI가 "{name.trim() || "새 유형"}" 가이드를 작성하고 있어요. 진행 상황은 오른쪽 AI
                창에 표시됩니다. 추가로 확인이 필요하면 그 창에서 물어보니, 답해주시면 이어서
                진행돼요.
              </p>
              <div className={styles.mtActions}>
                <button type="button" className={styles.mtGhost} onClick={onCancel}>
                  중단
                </button>
              </div>
            </section>
          )}

          {/* 미리보기 + 다듬기 */}
          {session.phase === "preview" && session.staged != null && (
            <section className={`${styles.mtPreview} ${styles.mtPreviewActive}`}>
              <span className={styles.mtPreviewLabel}>
                미리보기 — 이런 회의록이 만들어집니다. 저장하면 이 유형으로 확정됩니다
              </span>
              <TypeViewer
                content={session.staged}
                full={session.previewFull}
                onSetFull={session.setPreviewFull}
                actions={
                  <div className={styles.mtActions}>
                    <button
                      type="button"
                      className={styles.mtPrimary}
                      onClick={onSave}
                      aria-disabled={!session.committable}
                    >
                      저장
                    </button>
                    <button type="button" className={styles.mtGhost} onClick={onCancel}>
                      취소
                    </button>
                  </div>
                }
              />
              {session.spawnRequest != null && (
                <p className={styles.mtFormHint}>
                  더 바꾸려면 오른쪽 AI 창에 입력하세요 (예: "Q&A 섹션 추가", "더 간결하게"). 변경은
                  미리보기에 바로 반영됩니다. 마음에 들면 저장을 눌러주세요.
                </p>
              )}
            </section>
          )}
        </div>
      </TerminalWorkspace>
    </>
  );
}
