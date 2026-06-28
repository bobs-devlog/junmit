import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useBlocker } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import TerminalWorkspace from "@/components/TerminalWorkspace";
import TypeViewer from "@/components/TypeViewer";
import { useToast } from "@/contexts/ToastContext";
import { useDialog } from "@/contexts/DialogContext";
import { useTemplateSession } from "@/hooks/useTemplateSession";
import { killPty } from "@/utils/pty";
import type { MeetingTypeOption } from "@/types";
import styles from "./MeetingTypes.module.css";

// 회의 유형 상세 (디테일). 보기(예시/가이드) + 조정(AI 대화) + 직접 편집 + 삭제.
export default function MeetingTypeDetailScreen() {
  const params = useParams();
  const id = decodeURIComponent(params.id ?? "");
  const navigate = useNavigate();
  const sidebarTarget = useSidebarTarget();
  const toast = useToast();
  const { confirm } = useDialog();
  const session = useTemplateSession();

  const [types, setTypes] = useState<MeetingTypeOption[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [viewFull, setViewFull] = useState(false);
  // 직접 편집 모드 + 편집 텍스트.
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  const option = types.find((t) => t.id === id) ?? null;

  const load = useCallback(() => {
    Promise.all([
      invoke<MeetingTypeOption[]>("cmd_list_meeting_types").catch(() => [] as MeetingTypeOption[]),
      invoke<string | null>("cmd_read_meeting_type", { name: id }).catch(() => null),
    ]).then(([list, raw]) => {
      setTypes(list);
      setContent(raw);
      setLoaded(true);
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // 조정(AI) — 현재본을 미리보기에 띄우고 터미널 대화 시작.
  const onAdjust = useCallback(() => {
    if (content == null) return;
    session.launchAdjust(id, content);
  }, [content, id, session]);

  const onAdjustSave = useCallback(async () => {
    if (await session.save(option?.label ?? id)) load();
  }, [session, option, id, load]);

  // 직접 편집 저장 — Rust 게이트 검증.
  const onSaveEdit = useCallback(() => {
    invoke("cmd_save_meeting_type", { target: id, content: editText })
      .then(() => {
        toast.show("가이드를 저장했습니다.");
        setContent(editText);
        setEditing(false);
        load();
      })
      .catch((e) => toast.show(`저장하지 못했습니다: ${e}`));
  }, [id, editText, toast, load]);

  // 조정 취소 — 다듬은 내용이 있으면(committable) 확인 후 보기로 복귀.
  const onAdjustCancel = useCallback(async () => {
    if (session.committable) {
      const ok = await confirm({
        title: "조정한 내용을 버릴까요?",
        body: "저장하지 않으면 변경 내용이 사라집니다.",
        confirmLabel: "버리기",
        cancelLabel: "계속 다듬기",
        danger: true,
      });
      if (!ok) return;
    }
    session.cancel();
  }, [session, confirm]);

  // 직접 편집 취소 — 수정한 게 있으면 확인 후 닫기.
  const onEditCancel = useCallback(async () => {
    if (editText !== content) {
      const ok = await confirm({
        title: "편집을 취소할까요?",
        body: "수정한 내용이 사라집니다.",
        confirmLabel: "취소하고 닫기",
        cancelLabel: "계속 편집",
        danger: true,
      });
      if (!ok) return;
    }
    setEditing(false);
  }, [editText, content, confirm]);

  const onDelete = useCallback(async () => {
    if (!option) return;
    const isLast = types.length <= 1;
    const lines = [
      `"${option.label}" 유형을 삭제할까요?`,
      "이 유형으로 작성됐던 과거 회의를 다시 작성하면 자동 판단(또는 자유 형식)으로 처리됩니다.",
    ];
    if (isLast) lines.push("마지막 유형이라 삭제 후에는 모든 회의가 자유 형식으로 작성됩니다.");
    const ok = await confirm({
      title: "회의 유형 삭제",
      body: lines.join("\n"),
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    invoke("cmd_delete_meeting_type", { name: id })
      .then(() => {
        toast.show(`"${option.label}" 유형을 삭제했습니다.`);
        navigate("/meeting-types");
      })
      .catch((e) => toast.show(`삭제하지 못했습니다: ${e}`));
  }, [option, types.length, confirm, id, toast, navigate]);

  // 조정 중·직접 편집 중 화면 이탈 시 컨펌.
  const hasUnsaved = session.active || editing;
  const blocker = useBlocker(hasUnsaved);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({
      title: "저장하지 않고 나갈까요?",
      body: "지금 나가면 변경 내용이 저장되지 않습니다.",
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

  const inSession = session.active; // 조정(AI) 진행/미리보기 중
  const label = option?.label ?? id;

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
          {!loaded ? (
            <p className={styles.mtEmpty}>불러오는 중…</p>
          ) : content == null || option == null ? (
            <p className={styles.mtEmpty}>유형을 찾을 수 없습니다. 목록으로 돌아가 주세요.</p>
          ) : inSession && session.staged != null ? (
            /* ── 조정(AI) 미리보기 ── */
            <section className={`${styles.mtPreview} ${styles.mtPreviewActive}`}>
              <span className={styles.mtPreviewLabel}>
                "{label}" 조정 미리보기 — 저장하면 이 내용으로 덮어씁니다
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
                      onClick={onAdjustSave}
                      aria-disabled={!session.committable}
                    >
                      저장
                    </button>
                    <button type="button" className={styles.mtGhost} onClick={onAdjustCancel}>
                      취소
                    </button>
                  </div>
                }
              />
              {session.spawnRequest != null && (
                <p className={styles.mtFormHint}>
                  바꿀 점을 오른쪽 AI 창에 입력하세요 (예: "결정사항을 표로", "액션 아이템에 기한
                  추가"). 변경은 미리보기에 바로 반영됩니다. 마음에 들면 저장을 눌러주세요.
                </p>
              )}
            </section>
          ) : editing ? (
            /* ── 직접 편집 ── */
            <section className={`${styles.mtPreview} ${styles.mtPreviewActive}`}>
              <span className={styles.mtPreviewLabel}>"{label}" 직접 편집</span>
              <textarea
                className={styles.mtEditArea}
                value={editText}
                rows={20}
                onChange={(e) => setEditText(e.target.value)}
              />
              <p className={styles.mtFormHint}>
                가이드 원문을 직접 편집합니다. 유형 이름·요약·예시 형식이 맞아야 저장됩니다.
              </p>
              <div className={styles.mtActions}>
                <button type="button" className={styles.mtPrimary} onClick={onSaveEdit}>
                  저장
                </button>
                <button type="button" className={styles.mtGhost} onClick={onEditCancel}>
                  취소
                </button>
              </div>
            </section>
          ) : (
            /* ── 보기 ── */
            <>
              <header className={styles.mtHeader}>
                <h1 className={styles.mtTitle}>{option.label}</h1>
                <p className={styles.mtDesc}>{option.description}</p>
              </header>
              <div className={styles.mtActions}>
                <button type="button" className={styles.mtPrimary} onClick={onAdjust}>
                  AI로 조정
                </button>
                <button
                  type="button"
                  className={styles.mtGhost}
                  onClick={() => {
                    setEditText(content);
                    setEditing(true);
                  }}
                >
                  직접 편집
                </button>
                <button type="button" className={styles.mtDanger} onClick={onDelete}>
                  삭제
                </button>
              </div>
              <section className={styles.mtPreview}>
                <TypeViewer content={content} full={viewFull} onSetFull={setViewFull} />
              </section>
            </>
          )}
        </div>
      </TerminalWorkspace>
    </>
  );
}
