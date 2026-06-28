import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { MeetingNote } from "@/types";

interface UseRecordingNotes {
  // 렌더용 메모 목록.
  notes: MeetingNote[];
  // 최신값 미러 — 종료 핸들러(handleStop)가 stale 없이 읽어 notes.json으로 flush.
  notesRef: RefObject<MeetingNote[]>;
  addSpeaker: (speaker: string) => void;
  addText: (text: string) => void;
  editText: (index: number, text: string) => void;
  removeNote: (index: number) => void;
}

// 녹음 중 메모(화자 힌트·자유 메모) 상태 관리 — RecordingScreen에서 분리한 단일 책임(SRP).
// 발화 시점 t는 호출 시점의 elapsed로 캡처한다(elapsedRef로 stale closure 회피).
export default function useRecordingNotes(elapsed: number): UseRecordingNotes {
  const [notes, setNotes] = useState<MeetingNote[]>([]);
  const notesRef = useRef<MeetingNote[]>(notes);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  // listen/클릭 콜백 안에서 최신 elapsed 참조용 (stale closure 회피).
  const elapsedRef = useRef(elapsed);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  const addNote = useCallback((note: MeetingNote) => {
    setNotes((prev) => [...prev, note]);
  }, []);
  const removeNote = useCallback((index: number) => {
    setNotes((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const editText = useCallback((index: number, text: string) => {
    setNotes((prev) => prev.map((n, i) => (i === index ? { ...n, text } : n)));
  }, []);
  const addSpeaker = useCallback(
    (speaker: string) => addNote({ t: elapsedRef.current, kind: "speaker", speaker }),
    [addNote]
  );
  const addText = useCallback(
    (text: string) => addNote({ t: elapsedRef.current, kind: "text", text }),
    [addNote]
  );

  return { notes, notesRef, addSpeaker, addText, editText, removeNote };
}
