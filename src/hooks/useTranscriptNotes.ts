import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { MeetingNote } from "@/types";
import { buildNotePlacement, loadRecordingNotes } from "@/utils/recordingNotes";
import type { PlacedNote, PlacementLine } from "@/utils/recordingNotes";

interface UseTranscriptNotes {
  // 발화 줄 인덱스 → 그 줄 화자 칩 옆에 표시할 화자 힌트(🎙 마커)들.
  markersByLine: Map<number, PlacedNote[]>;
  // 발화 줄 인덱스(-1 = 본문 최상단) → 그 줄 뒤에 표시할 자유 메모 행들.
  rowsByLine: Map<number, PlacedNote[]>;
  // "메모 N" 칩의 N — 자유 메모 수 (화자 힌트 제외, 0이면 칩 미표시).
  textNoteCount: number;
  // "메모 N" 칩 클릭 — 다음 자유 메모 행으로 스크롤 + 잠깐 강조 (시간순 순회, 끝나면 처음부터).
  jumpToNextNote: () => void;
}

// 전사본 탭의 녹음 메모 표시 관심사 — 로드·배치·"메모 N" 순회를 한 곳에 모은 훅.
// TranscriptEditor에서 분리한 이유: 이 기능의 불변식(순회 flash는 setState가 아니라 DOM
// 클래스 토글 — 상태로 하면 메모화되지 않은 전체 줄이 켜기·끄기 두 번 전량 리렌더,
// 세션 전환 시 순회 위치·flash 정리, 언마운트 타이머 정리)이 컴포넌트 곳곳에 흩어지면
// 수정할 때 하나를 놓치기 쉽다. 렌더(JSX)는 컴포넌트 몫 — 여기는 상태와 행동만.
//
// flashClass: 강조 애니메이션 CSS 클래스(컴포넌트의 teLineFlash) — CSS module은 컴포넌트
// 소유라 주입받는다. 메모 행의 className이 정적(이 클래스를 prop으로 갖지 않음)이어야
// React 재조정이 수동 추가한 클래스를 지우지 않는다는 전제가 이 훅의 핵심 불변식.
export default function useTranscriptNotes(
  sessionPath: string,
  lines: PlacementLine[],
  linesRef: RefObject<HTMLElement | null>,
  flashClass: string
): UseTranscriptNotes {
  const [notes, setNotes] = useState<MeetingNote[]>([]);
  const noteCycleRef = useRef(0);
  const noteFlashTimer = useRef<number | null>(null);
  // 직전 강조 행 — 1.3초 안에 다음 메모로 넘어가면 이전 클래스를 먼저 걷는다.
  const noteFlashEl = useRef<HTMLElement | null>(null);

  // notes.json은 녹음 종료 시 한 번 쓰이는 파일 — 세션 전환 때만 다시 읽으면 된다
  // (화자 재할당 등의 전사 재로드와 무관). 전환 시 이전 세션의 순회 위치·flash도 함께 리셋.
  // 첫 마운트엔 리셋을 스킵(이미 초기값) — TranscriptEditor의 세션 리셋 effect와 같은 패턴.
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (prevSessionRef.current !== null && prevSessionRef.current !== sessionPath) {
      setNotes([]);
      noteCycleRef.current = 0;
      if (noteFlashTimer.current) window.clearTimeout(noteFlashTimer.current);
      noteFlashEl.current = null;
    }
    prevSessionRef.current = sessionPath;
    void loadRecordingNotes(sessionPath).then((loaded) => {
      if (!cancelled && loaded.length > 0) setNotes(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionPath]);

  // 언마운트 시 타이머 정리.
  useEffect(
    () => () => {
      if (noteFlashTimer.current) window.clearTimeout(noteFlashTimer.current);
    },
    []
  );

  // lines가 아직 비어 있으면(전사 로드 전) 배치를 미룬다 — 메모가 전사보다 먼저 도착하는
  // 프레임에 최상단(-1) 행이 잠깐 나타났다 사라지는 깜빡임 방지.
  const { markersByLine, rowsByLine } = useMemo(
    () =>
      lines.length === 0
        ? {
            markersByLine: new Map<number, PlacedNote[]>(),
            rowsByLine: new Map<number, PlacedNote[]>(),
          }
        : buildNotePlacement(notes, lines),
    [notes, lines]
  );

  // "메모 N" 칩의 개수·순회 대상 — rowsByLine(실제 배치된 자유 메모 행)에서 파생한다.
  // notes 배열에서 직접 세지 않는 이유: rowsByLine은 lines.length===0 게이트를 타므로,
  // notes 기준으로 세면 전사 로드 전 프레임(메모가 전사보다 먼저 도착)이나 빈 전사에서
  // 칩 개수는 N인데 화면 행은 0개가 되어 칩·행·점프 대상이 어긋난다. rowsBy 파생이면 셋이
  // 항상 lockstep. noteIndex(원본 notes 인덱스=data-note-index)를 시간순으로 모은다
  // (Map 삽입 순서가 앵커 시간에 어긋날 수 있어 정렬).
  const textNoteIndices = useMemo(() => {
    const indices: number[] = [];
    for (const arr of rowsByLine.values()) for (const { noteIndex } of arr) indices.push(noteIndex);
    return indices.sort((a, b) => a - b);
  }, [rowsByLine]);

  // 강조는 setState가 아니라 대상 행의 클래스 토글(이유는 헤더 불변식 참조).
  // reflow(offsetWidth)로 같은 행 연속 강조 시 애니메이션 재시작.
  const jumpToNextNote = () => {
    const total = textNoteIndices.length;
    if (total === 0) return;
    const pos = noteCycleRef.current % total;
    noteCycleRef.current = pos + 1;
    const el = linesRef.current?.querySelector<HTMLElement>(
      `[data-note-index="${textNoteIndices[pos]}"]`
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    noteFlashEl.current?.classList.remove(flashClass);
    void el.offsetWidth;
    el.classList.add(flashClass);
    noteFlashEl.current = el;
    if (noteFlashTimer.current) window.clearTimeout(noteFlashTimer.current);
    noteFlashTimer.current = window.setTimeout(() => el.classList.remove(flashClass), 1300);
  };

  return { markersByLine, rowsByLine, textNoteCount: textNoteIndices.length, jumpToNextNote };
}
