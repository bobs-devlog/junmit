import { useState, useCallback, useEffect } from "react";
import NotesMarkdownView from "../NotesMarkdownView";
import { substituteNames } from "@/utils/meetingNotes";
import { loadMeetingMeta } from "@/utils/meetingMeta";
import { copyMarkdownRich } from "@/utils/clipboard";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "@/contexts/SessionContext";
import { Activity } from "@/constants";
import type { MeetingTypeOption, SpeakerMapping } from "@/types";
import styles from "./NotesPreview.module.css";

// 회의록 검토 시점엔 "자동 판단"이 의미 약함 (이미 한 번 판단된 결과가 type에 박혀 있음).
// 다만 type="auto" 잔존 세션 (마이그레이션 누락 또는 LLM 갱신 실패)에 한해 동적으로 prepend — 안전판.
const AUTO_OPTION: MeetingTypeOption = {
  id: "auto",
  label: "자동 판단",
  description: "AI가 내용 보고 판단",
};

// templates 외 특수 옵션 — 정형 템플릿 없이 LLM이 회의 흐름에 맞춰 자유롭게 작성.
// 가이드는 notes-rules.md의 "Free-form 작성" 절이 단일 진실 원천.
const FREE_FORM_OPTION: MeetingTypeOption = {
  id: "free-form",
  label: "자유 형식",
  description: "정형 템플릿 없이 회의 흐름에 맞춰 작성",
};

interface CopyButtonProps {
  text: string;
}

function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await copyMarkdownRich(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button className={styles.svCopyBtn} onClick={handleCopy}>
      {copied ? "✓ 복사됨" : "복사"}
    </button>
  );
}

interface NotesPreviewProps {
  rawNotes: string | null;
  mapping: SpeakerMapping | null;
  sessionPath: string;
  onEdit: () => void;
  onRetypeNotes?: (newType: string) => Promise<boolean>;
}

/**
 * 회의록 읽기 전용 뷰 + 액션 바.
 * 유형 드롭다운만 자체 state 보유 (현재 type + 옵션 목록 로드).
 */
export default function NotesPreview({
  rawNotes,
  mapping,
  sessionPath,
  onEdit,
  onRetypeNotes,
}: NotesPreviewProps) {
  const loaded = rawNotes != null;
  // CopyButton에 전달할 치환된 텍스트. NotesMarkdownView 내부도 같은 substituteNames 호출.
  const displayMd = substituteNames(rawNotes, mapping);

  // 재작성 중에는 select 잠금 — restartCompose 시작~phase_done 신호 도착까지 분 단위 진행 중.
  // restartCompose await는 PTY spawn까지만 의미하므로 시스템 진실 상태(activity)로 잠가야 완료까지 보장.
  const { activity } = useSession();
  const isComposing = activity === Activity.Composing;

  const [currentType, setCurrentType] = useState<string>("free-form");
  const [typeOptions, setTypeOptions] = useState<MeetingTypeOption[]>([FREE_FORM_OPTION]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [meta, opts] = await Promise.all([
        loadMeetingMeta(sessionPath),
        invoke<MeetingTypeOption[]>("cmd_list_meeting_types").catch(() => []),
      ]);
      if (cancelled) return;
      const type = meta?.type || "free-form";
      setCurrentType(type);
      // type="auto" 케이스만 AUTO 옵션 prepend (안전판 — 마이그레이션 누락 또는 LLM 갱신 직전 케이스)
      const base =
        type === "auto" ? [AUTO_OPTION, FREE_FORM_OPTION, ...opts] : [FREE_FORM_OPTION, ...opts];
      setTypeOptions(base);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionPath]);

  const handleTypeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    // aria-disabled 가드 — native disabled가 아니라 JS에서 차단해야 글리프 깜빡임 회피.
    if (!loaded || isComposing) return;
    const next = e.target.value;
    if (next === currentType) return;
    if (!onRetypeNotes) return;
    // 낙관적 업데이트 — 사용자 선택을 select에 즉시 반영. 재작성은 분 단위 작업이라
    // 그 동안 옛 값을 표시하면 "내 클릭이 안 먹혔나?"라는 혼란이 생김.
    const prev = currentType;
    setCurrentType(next);
    const confirmed = await onRetypeNotes(next);
    if (!confirmed) {
      setCurrentType(prev);
    }
  };

  const handleEditClick = () => {
    // 다른 액션(다시 쓰기·유형 변경)과 동일하게 AI 작성 중에는 편집 진입을 막는다.
    // 작성 중 편집하면 완료 시 화면이 새로고침되며 입력이 사라질 수 있음(소실 방지).
    if (!loaded || isComposing) return;
    onEdit();
  };

  // 현재 유형 그대로 재작성 — 화자 교정(라벨 재할당)을 회의록 본문에 반영하는 경로.
  // 유형 select는 next===currentType이면 무시하므로, 같은 유형 재작성은 이 버튼이 담당.
  const handleRewriteClick = () => {
    if (!loaded || isComposing || !onRetypeNotes) return;
    void onRetypeNotes(currentType);
  };

  return (
    <>
      <div className="notes-pane-actions">
        <button
          className="sv-action-btn"
          onClick={handleEditClick}
          aria-disabled={!loaded || isComposing}
          title={
            isComposing
              ? "AI가 회의록을 작성하는 중입니다. 완료 후 편집할 수 있어요."
              : loaded
                ? "회의록 원본 편집 (SPEAKER_XX 라벨 유지 필수)"
                : "로딩 중..."
          }
        >
          ✏️ 편집
        </button>
        <CopyButton text={displayMd} />
        {onRetypeNotes && (
          <>
            <button
              className="sv-action-btn"
              onClick={handleRewriteClick}
              aria-disabled={!loaded || isComposing}
              title={
                isComposing
                  ? "재작성 중에는 다시 쓸 수 없습니다"
                  : "화자 교정을 반영해 현재 유형 그대로 회의록을 다시 작성합니다 (현재 본문은 자동 백업)"
              }
            >
              🔄 다시 쓰기
            </button>
            <select
              className="sv-action-btn"
              value={currentType}
              onChange={handleTypeChange}
              aria-disabled={!loaded || isComposing}
              title={
                isComposing
                  ? "재작성 중에는 유형을 변경할 수 없습니다"
                  : "유형을 바꾸면 회의록을 다시 작성합니다 (현재 본문은 자동 백업)"
              }
            >
              {typeOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  유형: {opt.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div className="notes-pane-body">
        <NotesMarkdownView markdown={displayMd} />
      </div>
    </>
  );
}
