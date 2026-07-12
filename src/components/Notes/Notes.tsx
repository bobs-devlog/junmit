import { useState, useEffect } from "react";
import { loadMeetingNotesMd, saveMeetingNotesMd, backupMeetingNotesMd } from "@/utils/meetingNotes";
import { loadSpeakerMapping } from "@/utils/speakerMapping";
import { useToast } from "@/contexts/ToastContext";
import { useSession } from "@/contexts/SessionContext";
import NotesPreview from "../NotesPreview";
import NotesEditor from "../NotesEditor";
import type { SpeakerMapping } from "@/types";
import styles from "./Notes.module.css";

interface NotesProps {
  sessionPath: string;
  onRetypeNotes?: (newType: string) => Promise<boolean>;
}

/**
 * 회의록 탭 컨테이너.
 * 파일 I/O + 모드 전환(view/edit)만 담당. 렌더링은 자식 컴포넌트에 위임.
 */
export default function Notes({ sessionPath, onRetypeNotes }: NotesProps) {
  const [rawNotes, setRawNotes] = useState<string | null>(null); // meeting-notes.md 원본 (SPEAKER_XX 포함)
  const [mapping, setMapping] = useState<SpeakerMapping | null>(null); // speaker_mapping
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  // notesRefreshKey: 검증 완료(verify 신호)의 회의록 탭 스코프 재로드 — 전체 remount 없이
  // 본문만 다시 읽는다(검증 중엔 편집이 잠겨 있어 읽기 전용 뷰의 in-place 갱신이 항상 안전).
  // setNotesEditing: 편집 중 도착한 범용 refresh(전체 remount)를 Context가 보류하기 위한 보고.
  const { notesRefreshKey, setNotesEditing } = useSession();

  useEffect(() => {
    // 편집 중에는 재로드하지 않는다 — rawNotes는 handleSave 충돌 감지의 "편집 시작 시점" 기준선이라,
    // 편집 중 갱신되면(예: 잠금 타임아웃 후 늦게 온 verify 재로드) 그 사이 AI가 쓴 변경을 사용자
    // 저장이 백업 없이 덮어쓴다. 건너뛴 재로드는 편집 종료(editing false) 시 이 effect가 다시 돈다.
    if (editing) return;
    let cancelled = false;
    (async () => {
      const [md, map] = await Promise.all([
        loadMeetingNotesMd(sessionPath),
        loadSpeakerMapping(sessionPath),
      ]);
      if (!cancelled) {
        setRawNotes(md);
        setMapping(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionPath, notesRefreshKey, editing]);

  // 편집 모드 진입/이탈을 Context에 보고 — 언마운트(세션 전환·합치기 remount)도 이탈로 정리.
  useEffect(() => {
    setNotesEditing(editing);
    return () => setNotesEditing(false);
  }, [editing, setNotesEditing]);

  const handleSave = async (content: string) => {
    try {
      // 편집하는 사이 다른 주체(AI 추가 요청 등)가 파일을 썼으면 그 버전을 백업하고 사용자
      // 버전을 저장 — 조용한 덮어쓰기 방지(머지 UI 없이 데이터 보존 + 사실 고지).
      const disk = await loadMeetingNotesMd(sessionPath);
      if (disk != null && rawNotes != null && disk !== rawNotes) {
        await backupMeetingNotesMd(sessionPath, disk);
        toast.info("편집하는 동안 AI가 회의록을 수정했어요. AI 버전은 백업으로 보관했어요");
      }
      await saveMeetingNotesMd(sessionPath, content);
      setRawNotes(content);
      setEditing(false);
      toast.success("✓ 저장됨");
    } catch (e) {
      toast.error(`저장 실패: ${e}`);
    }
  };

  return (
    <div className={styles.notesPane}>
      {editing ? (
        <NotesEditor
          initialContent={rawNotes}
          mapping={mapping}
          onSave={handleSave}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <NotesPreview
          rawNotes={rawNotes}
          mapping={mapping}
          sessionPath={sessionPath}
          onEdit={() => setEditing(true)}
          onRetypeNotes={onRetypeNotes}
        />
      )}
    </div>
  );
}
