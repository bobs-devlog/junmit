import { useState, useEffect, useCallback } from "react";
import clsx from "clsx";
import { loadMeetingNotesMd, substituteNames } from "@/utils/meetingNotes";
import { loadSpeakerMapping } from "@/utils/speakerMapping";
import { loadPublishConfig, updatePublishConfig, defaultPublishConfig } from "@/utils/publishMeta";
import { useDialog } from "@/contexts/DialogContext";
import { useToast } from "@/contexts/ToastContext";
import type { PublishConfig, ConfluencePublishMode, SpeakerMapping } from "@/types";
import styles from "./PublishModal.module.css";

interface Props {
  open: boolean;
  sessionPath: string;
  onDismiss: () => void;
  // 사용자가 모드별 액션 버튼을 눌렀을 때 호출. 호출자가 PTY/Frontend 분기 처리 + 본 modal 닫기.
  // displayMd는 SPEAKER_XX 치환된 회의록 markdown (append 모드 클립보드용).
  // Promise를 반환하면 완료까지 버튼이 "확인 중…" busy 상태가 된다 — codex 발행 게이트의
  // 인증 판정(외부 프로세스 ~1초+)처럼 트리거가 즉답이 아닌 경우의 무반응 구간 제거.
  onConfirm: (mode: ConfluencePublishMode, displayMd: string) => void | Promise<void>;
  // create(새 페이지 자동 생성) 불가 사유 — 있으면 create 라디오를 비활성 + 이 문구를 안내하고
  // append로 유도한다. claude/codex는 undefined(create 가능), antigravity(추후 지원)·mlx는 사유 전달.
  createUnavailableReason?: string;
}

const MODE_LABELS: Record<ConfluencePublishMode, string> = {
  create: "새 페이지로 생성",
  // 실제 동작은 "클립보드 복사 → 사용자가 직접 붙여넣기". "기존 페이지에 추가"는 앱이 자동으로
  // 추가하는 것처럼 오해를 줘서, 복사+수동 붙여넣기임을 라벨에 그대로 드러낸다.
  append: "회의록 복사 (직접 붙여넣기)",
  skip: "등록하지 않음",
};

const MODE_BUTTON_LABELS: Record<ConfluencePublishMode, string> = {
  create: "Confluence에 등록",
  append: "회의록 복사하고 완료",
  skip: "건너뛰고 완료",
};

export default function PublishModal({
  open,
  sessionPath,
  onDismiss,
  onConfirm,
  createUnavailableReason,
}: Props) {
  const { confirm } = useDialog();
  const toast = useToast();
  const [config, setConfig] = useState<PublishConfig>(defaultPublishConfig);
  const [rawNotes, setRawNotes] = useState<string | null>(null);
  const [mapping, setMapping] = useState<SpeakerMapping | null>(null);
  const [parentUrlDraft, setParentUrlDraft] = useState("");
  // onConfirm 진행 중 — 버튼 "확인 중…" 표시 + 중복 클릭 가드.
  const [busy, setBusy] = useState(false);

  // open 시 데이터 로드. sessionPath 변경 시도 재로드.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [pub, md, map] = await Promise.all([
        loadPublishConfig(sessionPath),
        loadMeetingNotesMd(sessionPath),
        loadSpeakerMapping(sessionPath),
      ]);
      if (cancelled) return;
      setConfig(pub);
      setParentUrlDraft(pub.confluence.parentUrl);
      setRawNotes(md);
      setMapping(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionPath]);

  // ESC로 닫기 (open일 때만)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  const mode = config.confluence.mode;
  const published = config.confluence.published;
  const displayMd = substituteNames(rawNotes, mapping);
  // create(자동 발행) 불가 여부 — antigravity(추후)·mlx. 사유 문구가 있으면 disabled.
  const createDisabled = !!createUnavailableReason;

  // 모드 변경은 가드 없이 즉시 반영. published=true였다면 false로 reset (재발행 필요 상태로).
  // 실제 발행 위험은 handleConfirm의 재발행 confirm에서만 가드 (이중 confirm 회피).
  const handleModeChange = useCallback(
    async (next: ConfluencePublishMode) => {
      if (next === mode) return;
      try {
        const updated = await updatePublishConfig(sessionPath, {
          confluence: { ...config.confluence, mode: next, published: false },
        });
        setConfig(updated);
      } catch (e) {
        toast.error(`발행 설정 저장 실패: ${e}`);
      }
    },
    [mode, sessionPath, config.confluence, toast]
  );

  // create 불가(antigravity·mlx)인데 저장된 모드가 create면 append로 자동 전환 — 열자마자 유효한
  // 모드에 놓이게 한다.
  useEffect(() => {
    if (open && createDisabled && config.confluence.mode === "create") {
      void handleModeChange("append");
    }
  }, [open, createDisabled, config.confluence.mode, handleModeChange]);

  const handleParentUrlBlur = useCallback(async () => {
    const trimmed = parentUrlDraft.trim();
    if (trimmed === config.confluence.parentUrl) return;
    try {
      const updated = await updatePublishConfig(sessionPath, {
        confluence: { ...config.confluence, parentUrl: trimmed },
      });
      setConfig(updated);
      setParentUrlDraft(trimmed);
    } catch (e) {
      toast.error(`발행 설정 저장 실패: ${e}`);
    }
  }, [parentUrlDraft, sessionPath, config.confluence, toast]);

  const buttonDisabled = mode === "create" && !parentUrlDraft.trim();

  const handleConfirm = useCallback(async () => {
    if (buttonDisabled || busy) return;
    const trimmed = parentUrlDraft.trim();
    // create 모드 draft가 saved와 다르면 강제 저장 — onBlur·click race 방지.
    if (mode === "create" && trimmed !== config.confluence.parentUrl) {
      try {
        await updatePublishConfig(sessionPath, {
          confluence: { ...config.confluence, parentUrl: trimmed },
        });
      } catch (e) {
        toast.error(`발행 설정 저장 실패: ${e}`);
        return;
      }
    }
    // 재발행 가드: create + 이미 published인 경우 한 번 더 확인.
    if (mode === "create" && published) {
      const ok = await confirm({
        title: "이미 발행된 회의록입니다",
        body: (
          <>
            지금 발행하면 새 Confluence 페이지가 생성됩니다.
            <br />
            기존 페이지는 그대로 남고, 새로 만든 페이지가 이 회의의 발행 기록으로 저장됩니다.
            <br />
            계속할까요?
          </>
        ),
        confirmLabel: "재발행",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await onConfirm(mode, displayMd);
    } finally {
      setBusy(false);
    }
  }, [
    buttonDisabled,
    busy,
    mode,
    published,
    parentUrlDraft,
    sessionPath,
    config.confluence,
    displayMd,
    onConfirm,
    confirm,
    toast,
  ]);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onDismiss}>
      <div className={clsx("dialog-box", styles.dialog)} onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">Confluence 등록</h2>

        {published && config.confluence.pageUrl && (
          <div className={styles.publishedBadge}>
            ✅ 발행 완료 — <code>{config.confluence.pageUrl}</code>
          </div>
        )}

        <div className={styles.modeGroup}>
          {(["create", "append", "skip"] as ConfluencePublishMode[]).map((m) => {
            // create는 claude/codex에서만 가능. antigravity(추후)·mlx는 비활성 + 배지로 표시하고
            // 이유는 아래 안내로. aria-disabled + JS 가드(native disabled 글리프 깜빡임 회피).
            const disabled = m === "create" && createDisabled;
            return (
              <label
                key={m}
                className={clsx(
                  styles.modeOption,
                  mode === m && styles.checked,
                  disabled && styles.disabled
                )}
                aria-disabled={disabled || undefined}
              >
                <input
                  type="radio"
                  name="publish-mode"
                  checked={mode === m}
                  onChange={() => {
                    if (!disabled) handleModeChange(m);
                  }}
                />
                <span>{MODE_LABELS[m]}</span>
                {disabled && <span className={styles.needConnect}>Claude·Codex 전용</span>}
              </label>
            );
          })}
        </div>

        {createDisabled && <div className={styles.notice}>{createUnavailableReason}</div>}

        <div className={styles.modeContent}>
          {mode === "create" && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>상위 페이지 URL</label>
              <input
                type="text"
                className={styles.input}
                placeholder="https://your-domain.atlassian.net/wiki/spaces/..."
                value={parentUrlDraft}
                onChange={(e) => setParentUrlDraft(e.target.value)}
                onBlur={handleParentUrlBlur}
              />
            </div>
          )}

          {mode === "append" && (
            <div className={styles.notice}>
              확인을 누르면 회의록이 클립보드에 복사됩니다.
              <br />
              기존 Confluence 페이지에 직접 붙여넣어주세요.
            </div>
          )}

          {mode === "skip" && (
            <div className={styles.notice}>
              Confluence 등록 없이 회의를 마무리합니다.
              <br />
              회의록은 [회의록] 탭에서 언제든 확인할 수 있습니다.
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onDismiss}>
            취소
          </button>
          <button
            className={clsx(styles.confirmBtn, "btn", "btn-primary")}
            onClick={handleConfirm}
            aria-disabled={buttonDisabled || busy}
            title={buttonDisabled ? "상위 페이지 URL을 입력해주세요" : undefined}
          >
            {busy ? "확인 중…" : MODE_BUTTON_LABELS[mode]}
          </button>
        </div>
      </div>
    </div>
  );
}
