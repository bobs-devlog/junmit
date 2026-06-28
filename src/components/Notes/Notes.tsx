import { useState, useEffect } from "react";
import { loadMeetingNotesMd, saveMeetingNotesMd } from "@/utils/meetingNotes";
import { loadSpeakerMapping } from "@/utils/speakerMapping";
import { useToast } from "@/contexts/ToastContext";
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

  useEffect(() => {
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
  }, [sessionPath]);

  const handleSave = async (content: string) => {
    try {
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
