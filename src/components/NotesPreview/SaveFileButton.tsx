// 회의록을 .md 파일로 저장 — 네이티브 저장 패널 → 제목 헤딩 + 이름 치환본 기록 →
// "Finder에서 보기" 토스트. 복사와 같은 읽기 전용 파생이라 AI 작성·검증 중에도 잠그지 않는다.
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useToast } from "@/contexts/ToastContext";
import { withTitleHeading } from "@/utils/meetingNotes";

interface SaveFileButtonProps {
  /** 저장할 본문 — 복사와 동일한 이름 치환본(SPEAKER_XX → 실명). */
  text: string;
  /** 저장 패널 기본 파일명 재료 (회의 제목). */
  title: string;
  /** 회의록 로드 여부 — 미로드 상태에서 빈 파일이 저장되는 것을 막는다. */
  loaded: boolean;
}

export default function SaveFileButton({ text, title, loaded }: SaveFileButtonProps) {
  const toast = useToast();

  const handleSave = useCallback(async () => {
    if (!loaded) return; // aria-disabled 가드

    // 제목의 경로 예약 문자만 정리 (저장 패널 기본 파일명용 — 최종 이름은 사용자가 정함).
    const safeName = title.replace(/[/\\:]/g, " ").trim() || "회의록";
    let path: string | null;
    try {
      path = await save({
        defaultPath: `${safeName}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch {
      // 취소(null)와 달리 패널 자체가 안 열린 실패 — 무음이면 "눌러도 아무 일 없음"이 된다.
      toast.error("저장 창을 열지 못했어요. 다시 시도해 주세요.");
      return;
    }

    if (!path) return; // 취소
    try {
      await invoke<void>("cmd_export_text_file", {
        path,
        content: withTitleHeading(text, title),
      });
      toast.success("회의록을 저장했어요", {
        action: {
          label: "Finder에서 보기",
          onClick: () => void invoke("cmd_reveal_in_finder", { path }).catch(() => {}),
        },
      });
    } catch {
      toast.error("저장하지 못했어요. 다시 시도해 주세요.");
    }
  }, [text, title, loaded, toast]);

  return (
    <button
      className="sv-action-btn"
      onClick={handleSave}
      aria-disabled={!loaded}
      title={loaded ? "회의록을 Markdown 파일로 저장" : "로딩 중..."}
    >
      ⬇ 파일로 저장
    </button>
  );
}
