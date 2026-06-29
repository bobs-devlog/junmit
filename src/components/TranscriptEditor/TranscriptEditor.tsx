import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import clsx from "clsx";
import { useToast } from "@/contexts/ToastContext";
import { useSession } from "@/contexts/SessionContext";
import { Activity } from "@/constants";
import {
  loadSpeakerMapping,
  saveSpeakerMapping,
  speakerState,
  countTriage,
  formatReason,
} from "@/utils/speakerMapping";
import type { SpeakerState } from "@/utils/speakerMapping";
import { reassignLines, restoreSnapshot } from "@/utils/speakerCorrection";
import type { CorrectionSnapshot } from "@/utils/speakerCorrection";
import { buildSpeakerLabels, buildSpeakerNumbers } from "@/utils/meetingNotes";
import { loadMeetingMeta } from "@/utils/meetingMeta";
import { loadAttendees } from "@/utils/attendees";
import type { SpeakerMapping } from "@/types";
import {
  loadTranscriptSpeakerEdits,
  buildEditsByLine as buildSpeakerEditsByLine,
} from "@/utils/transcriptEdits";
import type { SpeakerEdit } from "@/utils/transcriptEdits";
import {
  loadTranscriptTextEdits,
  buildEditsByLine as buildTextEditsByLine,
  splitLineByEdits,
} from "@/utils/textEdits";
import type { TextEdit } from "@/utils/textEdits";
import { TRANSCRIPT_LINE_RE } from "@/utils/transcript";
import SpeakerPicker from "../SpeakerPicker";
import SpeakerTargetPicker from "../SpeakerPicker/SpeakerTargetPicker";
import SpeakerEditMarker from "./SpeakerEditMarker";
import TextEditTooltip from "./TextEditTooltip";
import { invoke } from "@tauri-apps/api/core";
import styles from "./TranscriptEditor.module.css";

type SpeechLine = { type: "speech"; speaker: string; time: string; text: string };
type TextLine = { type: "text"; text: string; speaker?: undefined; time?: undefined };
type Line = SpeechLine | TextLine;

function parseLine(line: string): Line {
  const m = line.match(TRANSCRIPT_LINE_RE);
  if (!m) return { type: "text", text: line };
  return { type: "speech", speaker: m[1], time: m[2], text: m[3] };
}

// hue 간격이 명확한 12개 고대비 팔레트. 12명 초과 시 황금각(137.508°)으로
// hue 회전 — 무리수 특성상 아무리 많은 화자가 있어도 겹치지 않음.
const SPEAKER_COLORS = [
  "#60a5fa", // 파랑
  "#fbbf24", // 금색
  "#f87171", // 연빨강
  "#34d399", // 민트
  "#a78bfa", // 보라
  "#fb923c", // 주황
  "#22d3ee", // 청록
  "#f472b6", // 분홍
  "#84cc16", // 연두
  "#e879f9", // 마젠타
  "#fde047", // 노랑
  "#2dd4bf", // 터콰이즈
];
const UNKNOWN_COLOR = "#f59e0b"; // amber — LLM이 판단 유보한 구간

function speakerColor(speaker: string): string {
  if (speaker === "UNKNOWN") return UNKNOWN_COLOR;
  const num = parseInt(speaker.replace("SPEAKER_", ""), 10) || 0;
  if (num < SPEAKER_COLORS.length) return SPEAKER_COLORS[num];
  const hue = (num * 137.508) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

// speakerColor를 옅은 배경 채움색으로 — 매핑된(이름 확정) 화자 라벨 강조용.
// hex(#rrggbb)는 8자리 alpha suffix, hsl(...)은 hsla로 변환. (둘 다 speakerColor가 반환하는 형태)
function speakerTint(color: string): string {
  if (color.startsWith("#")) return `${color}22`; // ~13% alpha
  return color.replace(/^hsl\((.+)\)$/, "hsla($1, 0.13)");
}

interface SpeakerLabelProps {
  speaker: string;
  name?: string;
  // 매칭 상태(미확인/AI 추정/확정) — 칩 시각·팝오버 액션·hover ✓ 노출을 결정.
  state: SpeakerState;
  // AI 근거/역할 힌트 — 추정 칩 hover 툴팁 + 팝오버 상단 블록.
  reason?: string;
  // 트리거에 보이는 텍스트 — 매핑되면 이름, 미매핑이면 "참석자 N" (picker value와 별개).
  displayLabel: string;
  // picker 팝오버 제목 — "어느 화자인가" 식별자라 항상 순번("참석자 N"). 현재 이름은 picker의 "현재:" 줄이 표시.
  participantLabel: string;
  color: string;
  attendees: string[];
  onChange: (name: string) => void;
  onConfirm: () => void;
  onUnknown: () => void;
  onJumpToTime: (t: string) => void;
  onAddAttendee?: (name: string) => void;
  // 교정 진행 중 잠금 — 클릭(이름 매핑) 차단 + 시각 dimming.
  disabled?: boolean;
}

function SpeakerLabel({
  speaker,
  name,
  state,
  reason,
  displayLabel,
  participantLabel,
  color,
  attendees,
  onChange,
  onConfirm,
  onUnknown,
  onJumpToTime,
  onAddAttendee,
  disabled = false,
}: SpeakerLabelProps) {
  // UNKNOWN은 LLM이 판단 유보한 구간. 이름 매핑 대상 아님 (picker 비활성). 화자 재할당은 줄 체크박스로.
  if (speaker === "UNKNOWN") {
    return (
      <span
        className={clsx(styles.teSpeaker, styles.teSpeakerUnknown)}
        style={{ color, borderColor: color }}
        title="LLM이 판단 유보한 구간 — 줄을 체크해 화자 지정"
      >
        UNKNOWN
      </span>
    );
  }
  // 3상태: 확정=배경 채움+✓ / 추정=점선(미채움) / 미확인=빈 칩+✎.
  const confirmed = state === "confirmed";
  const guess = state === "guess";

  // 표면은 하나 — 클릭 시 뜨는 팝오버. 근거·확정·모르겠어요·이름 변경이 모두 그 안에 있다.
  // (hover 미리보기/인라인 ✓를 두지 않는 이유: hover/click 표면이 경쟁해 "뭘 눌러야 하나" 혼란을 부름)
  return (
    <SpeakerPicker
      value={name || ""}
      attendees={attendees}
      speaker={participantLabel}
      reason={reason}
      state={state}
      onChange={onChange}
      onConfirm={onConfirm}
      onUnknown={onUnknown}
      onJumpToTime={onJumpToTime}
      onAddAttendee={onAddAttendee}
      disabled={disabled}
      trigger={(open) => (
        <span
          className={clsx(
            styles.teSpeaker,
            confirmed && styles.teSpeakerConfirmed,
            guess && styles.teSpeakerGuess,
            disabled && styles.teLocked
          )}
          style={{
            color,
            borderColor: color,
            background: confirmed ? speakerTint(color) : undefined,
          }}
          onClick={open}
          aria-disabled={disabled || undefined}
          title={
            disabled
              ? "AI 작업 중 — 완료 후 수정할 수 있습니다"
              : confirmed
                ? "클릭하여 이름 변경 / 확정 취소"
                : guess
                  ? "AI 추정 — 클릭해 근거 확인·확정"
                  : "클릭해 이름 매핑"
          }
        >
          {displayLabel}
          {confirmed && <span className={styles.teConfirmMark}>✓</span>}
          {state === "unset" && <span className={styles.teMapHint}>✎</span>}
        </span>
      )}
    />
  );
}

interface SpeakerSummaryItemProps {
  speaker: string;
  name?: string;
  state: SpeakerState;
  reason?: string;
  displayLabel: string;
  participantLabel: string;
  color: string;
  attendees: string[];
  onChange: (name: string) => void;
  onConfirm: () => void;
  onUnknown: () => void;
  onJumpToTime: (t: string) => void;
  onAddAttendee?: (name: string) => void;
  // 교정 진행 중 잠금 — 클릭(이름 매핑) 차단 + 시각 dimming.
  disabled?: boolean;
}

function SpeakerSummaryItem({
  speaker,
  name,
  state,
  reason,
  displayLabel,
  participantLabel,
  color,
  attendees,
  onChange,
  onConfirm,
  onUnknown,
  onJumpToTime,
  onAddAttendee,
  disabled = false,
}: SpeakerSummaryItemProps) {
  // UNKNOWN: 정적 칩(이름 매핑 대상 아님 — 본문 라벨 클릭으로 줄별 확정).
  if (speaker === "UNKNOWN") {
    return (
      <span
        className={clsx(styles.teSummaryItem, styles.teSummaryItemUnknown)}
        style={{ borderColor: color }}
      >
        <span className={styles.teSummaryDot} style={{ background: color }} />
        {displayLabel}
      </span>
    );
  }
  const confirmed = state === "confirmed";
  const guess = state === "guess";
  return (
    <SpeakerPicker
      value={name || ""}
      attendees={attendees}
      speaker={participantLabel}
      reason={reason}
      state={state}
      onChange={onChange}
      onConfirm={onConfirm}
      onUnknown={onUnknown}
      onJumpToTime={onJumpToTime}
      onAddAttendee={onAddAttendee}
      disabled={disabled}
      trigger={(open) => (
        <span
          className={clsx(
            styles.teSummaryItem,
            guess && styles.teSummaryItemGuess,
            disabled && styles.teLocked
          )}
          style={{ borderColor: color, background: confirmed ? speakerTint(color) : undefined }}
          onClick={open}
          aria-disabled={disabled || undefined}
          title={
            disabled
              ? "AI 작업 중 — 완료 후 수정할 수 있습니다"
              : confirmed
                ? "클릭하여 화자 변경 / 확정 취소"
                : guess
                  ? "AI 추정 — 클릭해 근거 확인·확정"
                  : "클릭해 매핑"
          }
        >
          <span className={styles.teSummaryDot} style={{ background: color }} />
          {displayLabel}
          {confirmed && <span className={styles.teConfirmMark}>✓</span>}
          {state === "unset" && <span className={styles.teMapHint}>✎</span>}
        </span>
      )}
    />
  );
}

interface TranscriptEditorProps {
  sessionPath: string;
  attendees?: string[];
  // 화자 교정(라벨 재할당) 후 회의록 본문에 반영하려면 현재 유형으로 재작성한다(NotesPreview와 공유).
  onRetypeNotes?: (newType: string) => Promise<boolean>;
}

export default function TranscriptEditor({
  sessionPath,
  attendees = [],
  onRetypeNotes,
}: TranscriptEditorProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [mapping, setMapping] = useState<SpeakerMapping>({}); // { SPEAKER_XX: { name, reason } }
  const [sessionAttendees, setSessionAttendees] = useState<string[]>(attendees);
  // 교정본을 표시 중인지 여부. 교정본이 있으면 우선 사용하고, 없으면 원본을 사용한다.
  // 인라인 교정 마커/하이라이트는 교정본일 때만 의미가 있다.
  const [isCorrected, setIsCorrected] = useState(false);
  // 정밀 교정 여부 — "정밀 교정" 배지 표기 결정. 빠른 경로(정밀 끔)면 텍스트가 원문이라 미표기.
  const [isDetailed, setIsDetailed] = useState(false);
  const [speakerEdits, setSpeakerEdits] = useState<SpeakerEdit[]>([]);
  const [textEdits, setTextEdits] = useState<TextEdit[]>([]);
  // 화자 재할당용 줄 선택 집합(체크박스). lines 배열 인덱스.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // 직전 화자 교정 — "실행 취소"용(한 단계). label은 안내 문구.
  const [lastUndo, setLastUndo] = useState<{ snapshot: CorrectionSnapshot; label: string } | null>(
    null
  );
  // 현재 회의 유형 — "회의록 다시 쓰기" CTA가 같은 유형으로 재작성하도록 파일에서 읽어 둔다.
  const [currentType, setCurrentType] = useState<string>("free-form");
  // 화자 많을 때 요약 줄을 한 줄로 접음(공간 절약). 사용자가 "모두 보기"로 펼침.
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  // 근거 타임스탬프 점프 — 대상 줄 스크롤 + 잠깐 하이라이트.
  const linesRef = useRef<HTMLDivElement | null>(null);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);
  const toast = useToast();
  // 교정/작성 진행 중에는 화자 선택을 잠근다 — 줄 재할당이 sidecar의 transcript_corrected.txt
  // 동시 쓰기와 충돌하면 라인 매칭이 깨지고, 이름 매핑은 speaker-mapping 재생성과 race가 난다.
  const { activity, updateAttendees, isEditLocked } = useSession();

  // picker에서 입력한 새 이름을 명단에 추가(이름 지정 중 단발 추가). context+파일 동기.
  const handleAddAttendee = (name: string) => {
    if (sessionAttendees.includes(name)) return;
    void updateAttendees([...sessionAttendees, name]);
  };

  // 세션 전환 시 즉시 reset — 새 세션 로딩 중 이전 세션 데이터가 잠깐 보이는 잔상 방지.
  // 첫 마운트엔 스킵 (이미 빈 초기값) — 새 참조로 setState 호출하면 불필요한 commit이 한 번 더 발생.
  // attendees 변경 시엔 reset하지 않음 (라벨 깜빡임 방지).
  const prevSessionPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionPathRef.current !== null && prevSessionPathRef.current !== sessionPath) {
      setLines([]);
      setMapping({});
      setIsCorrected(false);
      setIsDetailed(false);
      setSpeakerEdits([]);
      setTextEdits([]);
      setSelected(new Set());
      setLastUndo(null);
    }
    prevSessionPathRef.current = sessionPath;
  }, [sessionPath]);

  // 전사·매핑·교정 데이터를 로드해 state에 반영. 저장 후 재호출(reload)로도 쓰므로 함수로 추출.
  // isCancelled: 세션 전환 race 가드(effect에서만 전달, reload는 생략).
  const loadData = useCallback(
    async (isCancelled?: () => boolean) => {
      // 모든 의존 데이터를 병렬로 로드한 뒤 setState를 동기적으로 연속 호출 →
      // React 18 자동 batching으로 한 번의 commit에 반영되어 라벨 깜빡임(SPEAKER_XX → 이름) 방지.
      const needsAttendeeFallback = !attendees || attendees.length === 0;
      const [
        correctedText,
        rawText,
        loadedAttendees,
        parsedMapping,
        loadedSpeakerEdits,
        loadedTextEdits,
        loadedMeta,
      ] = await Promise.all([
        invoke<string>("cmd_read_session_file", {
          sessionPath,
          filename: "transcript_corrected.txt",
        }).catch(() => null),
        invoke<string>("cmd_read_session_file", {
          sessionPath,
          filename: "transcript.txt",
        }).catch(() => null),
        needsAttendeeFallback ? loadAttendees(sessionPath) : Promise.resolve<string[]>([]),
        loadSpeakerMapping(sessionPath),
        loadTranscriptSpeakerEdits(sessionPath),
        loadTranscriptTextEdits(sessionPath),
        loadMeetingMeta(sessionPath),
      ]);
      if (isCancelled?.()) return;

      // 교정본 우선 → 없거나 빈 문자열이면 원본 fallback.
      // (||를 쓰는 이유: 빈 문자열 corrected를 "교정됨"으로 처리하지 않기 위함)
      const text = correctedText || rawText;
      const corrected = !!correctedText;

      setIsCorrected(corrected);
      // 정밀 = detailed_correction(신규 의도) 또는 text_edits 존재(기능 이전 기존 세션) 둘 중 하나.
      setIsDetailed(
        corrected && (loadedMeta?.detailed_correction === true || loadedTextEdits.length > 0)
      );
      if (text) {
        setLines(text.split("\n").map(parseLine));
      }
      // attendees prop 우선 → 없을 때만 attendees.json fallback.
      // prop이 갱신되는 경우(예: meeting 로드 완료) 동기화되도록 else 분기 명시.
      if (needsAttendeeFallback) {
        if (loadedAttendees.length > 0) setSessionAttendees(loadedAttendees);
      } else {
        setSessionAttendees(attendees);
      }
      setMapping(parsedMapping);
      setSpeakerEdits(loadedSpeakerEdits);
      setTextEdits(loadedTextEdits);
      setCurrentType(loadedMeta?.type || "free-form");
    },
    [sessionPath, attendees]
  );

  useEffect(() => {
    // 세션 전환 race 방지 — 이전 effect의 await가 늦게 도착해도 cancelled로 차단.
    let cancelled = false;
    const run = async () => {
      await loadData(() => cancelled);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [loadData]);

  // 라인 인덱스 → SpeakerEdit 매핑 (line 빠른 경로 + time/new_label fallback)
  const speakerEditsByLine = useMemo(
    () => buildSpeakerEditsByLine(speakerEdits, lines),
    [speakerEdits, lines]
  );
  // 라인 인덱스 → TextEdit[] 매핑 (한 라인에 여러 단어 교정 가능)
  const textEditsByLine = useMemo(() => buildTextEditsByLine(textEdits, lines), [textEdits, lines]);

  // SPEAKER_XX → 표시 라벨 (매핑되면 이름, 미매핑이면 "참석자 N"). mapping과 함께 재계산.
  const speakers = useMemo(
    () => [
      ...new Set(lines.filter((l): l is SpeechLine => l.type === "speech").map((l) => l.speaker)),
    ],
    [lines]
  );
  // 표시 라벨/순번 빌드용 키맵 — 매핑 ∪ transcript 등장 라벨. 매핑에 아직 없는 새 화자(빼내기로 생성)도
  // 포함해야 raw SPEAKER_XX가 아닌 "참석자 N"으로 보인다.
  const speakerKeys = useMemo(() => {
    const m: SpeakerMapping = { ...mapping };
    for (const sp of speakers) if (sp !== "UNKNOWN" && !m[sp]) m[sp] = { name: "", reason: "" };
    return m;
  }, [mapping, speakers]);
  const labels = useMemo(() => buildSpeakerLabels(speakerKeys), [speakerKeys]);
  // picker 제목용 순번 라벨 (항상 "참석자 N"). 이름이 있어도 식별자로 순번을 쓴다.
  const numbers = useMemo(() => buildSpeakerNumbers(speakerKeys), [speakerKeys]);

  // 이름 지정/변경 — 사용자가 직접 고른 이름이므로 확정(confirmed=true)으로 저장.
  // 빈 이름("해제")이면 미확인 복귀 — confirmed도 해제.
  const handleMap = async (speaker: string, name: string) => {
    if (isEditLocked) return;
    const confirmed = !!name;
    const nextMapping: SpeakerMapping = {
      ...mapping,
      [speaker]: { name, reason: mapping[speaker]?.reason ?? "", confirmed },
    };
    setMapping(nextMapping);

    try {
      await saveSpeakerMapping(sessionPath, speaker, { name, confirmed });
      // meeting-notes.md는 SessionViewer가 표시 시점에 치환하므로 파일 수정 없이 매핑만 저장.
      toast.success(name ? `✓ '${name}' 확정` : "✓ 미확인으로 되돌림");
    } catch (e) {
      toast.error(`저장 실패: ${e}`);
    }
  };

  // AI 추정 수락 — 이름 유지, 확정만 켬(hover ✓ / 팝오버 "맞아요·확정").
  const handleConfirm = async (speaker: string) => {
    if (isEditLocked) return;
    const name = mapping[speaker]?.name ?? "";
    if (!name) return;
    setMapping({ ...mapping, [speaker]: { ...mapping[speaker], name, confirmed: true } });
    try {
      await saveSpeakerMapping(sessionPath, speaker, { confirmed: true });
      toast.success(`✓ '${name}' 확정`);
    } catch (e) {
      toast.error(`저장 실패: ${e}`);
    }
  };

  // "모르겠어요" — 틀릴 수 있는 AI 이름을 떼고 미확인 복귀(reason은 힌트로 유지). 회의록은 표시 시점 "참석자 N".
  const handleUnknown = async (speaker: string) => {
    if (isEditLocked) return;
    setMapping({
      ...mapping,
      [speaker]: { name: "", reason: mapping[speaker]?.reason ?? "", confirmed: false },
    });
    try {
      await saveSpeakerMapping(sessionPath, speaker, { name: "", confirmed: false });
      toast.success("미확인으로 되돌렸어요");
    } catch (e) {
      toast.error(`저장 실패: ${e}`);
    }
  };

  const toggleLine = (i: number) => {
    if (isEditLocked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // 선택 줄(들)을 toLabel("__NEW__"면 새 빈 화자)로 재할당. 재할당 후 선택 해제·재로드·Undo 기록.
  const handleReassign = async (toLabel: string) => {
    if (isEditLocked) return;
    if (selected.size === 0) return;
    try {
      const { changedLines, newLabel, snapshot } = await reassignLines(
        sessionPath,
        [...selected],
        toLabel
      );
      setLastUndo({ snapshot, label: newLabel ? "새 화자로 빼내기" : "화자 바꾸기" });
      setSelected(new Set());
      await loadData();
      toast.success(
        newLabel
          ? `✓ ${changedLines}개 줄을 새 화자로 빼냈어요 (칩을 클릭해 이름 지정)`
          : `✓ ${changedLines}개 줄을 '${labelOf(toLabel)}'(으)로 바꿨어요`
      );
    } catch (e) {
      toast.error(`변경 실패: ${e}`);
    }
  };

  // 직전 교정 되돌리기 (한 단계).
  const handleUndo = async () => {
    if (isEditLocked) return;
    if (!lastUndo) return;
    try {
      await restoreSnapshot(sessionPath, lastUndo.snapshot);
      setLastUndo(null);
      await loadData();
      toast.success("✓ 되돌렸습니다");
    } catch (e) {
      toast.error(`되돌리기 실패: ${e}`);
    }
  };

  // 재할당 타깃 후보 — 실제 화자만(UNKNOWN 제외).
  const targetSpeakers = useMemo(() => speakers.filter((s) => s !== "UNKNOWN"), [speakers]);
  const labelOf = (label: string) => labels[label] ?? label;

  // triage 집계(확정 K / 확인 필요 M) + 화자 많을 때 요약 줄 접기.
  const triage = useMemo(() => countTriage(mapping, targetSpeakers), [mapping, targetSpeakers]);
  const SUMMARY_COLLAPSE_THRESHOLD = 6;
  const summaryCollapsed = targetSpeakers.length > SUMMARY_COLLAPSE_THRESHOLD && !summaryExpanded;

  // 근거의 타임스탬프(M:SS) → 전사본 해당 줄로 점프. 정확히 일치하는 줄(보통 sub-agent가 전사본
  // 타임스탬프를 그대로 인용)을 우선, 없으면 그 이전 가장 가까운 줄로 fallback. 잠깐 하이라이트.
  const toSec = (ts: string): number | null => {
    const m = /^(\d{1,3}):(\d{2})$/.exec(ts);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  const jumpToTime = (t: string) => {
    const target = toSec(t);
    if (target == null) return;
    let exact = -1;
    let prevIdx = -1;
    let prevSec = -1;
    let firstIdx = -1;
    lines.forEach((l, i) => {
      if (l.type !== "speech" || !l.time) return;
      const s = toSec(l.time);
      if (s == null) return;
      if (firstIdx === -1) firstIdx = i;
      if (s === target && exact === -1) exact = i;
      if (s <= target && s > prevSec) {
        prevSec = s;
        prevIdx = i;
      }
    });
    const idx = exact !== -1 ? exact : prevIdx !== -1 ? prevIdx : firstIdx;
    if (idx === -1) return;
    const el = linesRef.current?.querySelector<HTMLElement>(`[data-li="${idx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashLine(idx);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashLine(null), 1300);
  };
  // 언마운트 시 타이머 정리.
  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    []
  );

  return (
    <div className={styles.transcriptEditor}>
      {isEditLocked && (
        <div className={styles.teLockBanner}>
          AI가 {activity === Activity.Correcting ? "회의 내용을 다듬는" : "회의록을 작성하는"} 중입니다.
          완료 후 화자를 수정할 수 있습니다.
        </div>
      )}
      <div className={styles.teSummary}>
        {summaryCollapsed ? (
          <button
            type="button"
            className={styles.teSummaryCollapsed}
            onClick={() => setSummaryExpanded(true)}
            title="화자 칩 모두 보기"
          >
            화자 {targetSpeakers.length}명
            {triage.needsReview === 0 ? (
              <> · 모두 확정 ✓</>
            ) : (
              <>
                {" "}
                · {triage.confirmed} 확정 ·{" "}
                <b className={styles.teNeedsReview}>{triage.needsReview} 확인 필요</b>
              </>
            )}
            <span className={styles.teSummaryToggle}>모두 보기 ▾</span>
          </button>
        ) : (
          <>
            {speakers.map((sp) => (
              <SpeakerSummaryItem
                key={sp}
                speaker={sp}
                name={mapping[sp]?.name}
                state={speakerState(mapping[sp])}
                reason={formatReason(mapping[sp]?.reason)}
                displayLabel={labels[sp] ?? sp}
                participantLabel={numbers[sp] ?? sp}
                color={speakerColor(sp)}
                attendees={sessionAttendees}
                onChange={(name) => handleMap(sp, name)}
                onConfirm={() => handleConfirm(sp)}
                onUnknown={() => handleUnknown(sp)}
                onJumpToTime={jumpToTime}
                onAddAttendee={handleAddAttendee}
                disabled={isEditLocked}
              />
            ))}
            {targetSpeakers.length > 0 && (
              <span className={styles.teTriage}>
                {triage.needsReview === 0 ? (
                  "모두 확정 ✓"
                ) : (
                  <>
                    {triage.confirmed} 확정 ·{" "}
                    <b className={styles.teNeedsReview}>{triage.needsReview} 확인 필요</b>
                  </>
                )}
              </span>
            )}
            {targetSpeakers.length > SUMMARY_COLLAPSE_THRESHOLD && (
              <button
                type="button"
                className={styles.teSummaryToggle}
                onClick={() => setSummaryExpanded(false)}
              >
                접기 ▴
              </button>
            )}
          </>
        )}
        {lastUndo && (
          <button
            className={clsx(styles.teUndo, isEditLocked && styles.teLocked)}
            onClick={handleUndo}
            aria-disabled={isEditLocked || undefined}
            title={isEditLocked ? "AI 작업 중 — 완료 후 가능" : "직전 화자 교정을 되돌립니다"}
          >
            ↩ {lastUndo.label} · 실행 취소
          </button>
        )}
        {/* 배지 3-state: 처리 전=원본 / 정밀=정밀 교정 / 빠른 경로=무표기(텍스트 원문이라 "교정" 미표기). */}
        {!isCorrected ? (
          <span
            className={clsx(styles.teBadge, styles.teBadgeRaw)}
            title="교정 전 원본 전사본 — 교정 완료 시 자동 교체됨"
          >
            원본
          </span>
        ) : isDetailed ? (
          <span
            className={clsx(styles.teBadge, styles.teBadgeCorrected)}
            title="받아쓰기 오류까지 교정한 정밀 교정 전사본"
          >
            정밀 교정
          </span>
        ) : null}
      </div>

      <div className={styles.teLines} ref={linesRef}>
        {lines.map((line, i) => {
          // 인라인 마커/하이라이트는 교정본일 때만 — 원본은 교정 전이라 의미 X
          const speakerEdit = isCorrected ? speakerEditsByLine.get(i) : undefined;
          const textEditsForLine = isCorrected ? (textEditsByLine.get(i) ?? []) : [];
          if (line.type === "speech") {
            const segments = splitLineByEdits(line.text, textEditsForLine);
            return (
              <div
                key={i}
                data-li={i}
                className={clsx(
                  styles.teLine,
                  selected.has(i) && styles.teLineSelected,
                  flashLine === i && styles.teLineFlash
                )}
              >
                <input
                  type="checkbox"
                  className={clsx(styles.teLineCheck, isEditLocked && styles.teLocked)}
                  checked={selected.has(i)}
                  onChange={() => toggleLine(i)}
                  aria-disabled={isEditLocked || undefined}
                  aria-label={`${numbers[line.speaker] ?? line.speaker} 줄 선택`}
                />
                <span className={styles.teSpeakerGroup}>
                  <SpeakerLabel
                    speaker={line.speaker}
                    name={mapping[line.speaker]?.name}
                    state={speakerState(mapping[line.speaker])}
                    reason={formatReason(mapping[line.speaker]?.reason)}
                    displayLabel={labels[line.speaker] ?? line.speaker}
                    participantLabel={numbers[line.speaker] ?? line.speaker}
                    color={speakerColor(line.speaker)}
                    attendees={sessionAttendees}
                    onChange={(name) => handleMap(line.speaker, name)}
                    onConfirm={() => handleConfirm(line.speaker)}
                    onUnknown={() => handleUnknown(line.speaker)}
                    onJumpToTime={jumpToTime}
                    onAddAttendee={handleAddAttendee}
                    disabled={isEditLocked}
                  />
                  {speakerEdit && <SpeakerEditMarker edit={speakerEdit} />}
                </span>
                <span className={styles.teTime}>{line.time}</span>
                <span className={styles.teText}>
                  {segments.map((seg, j) =>
                    seg.edit ? (
                      <TextEditTooltip key={j} text={seg.text} edit={seg.edit} />
                    ) : (
                      <span key={j}>{seg.text}</span>
                    )
                  )}
                </span>
              </div>
            );
          }
          return line.text.trim() ? (
            <div key={i} className={clsx(styles.teLine, styles.tePlain)}>
              {line.text}
            </div>
          ) : null;
        })}
      </div>

      {selected.size > 0 && (
        <div className={styles.teActionBar}>
          <span className={styles.teActionCount}>선택한 {selected.size}줄</span>
          <SpeakerTargetPicker
            speakers={targetSpeakers}
            labelOf={labelOf}
            colorOf={speakerColor}
            allowNew
            title="선택한 줄을 어느 화자로?"
            onChange={(to) => handleReassign(to)}
            disabled={isEditLocked}
            trigger={(open) => (
              <button
                className={clsx(styles.teActionAssign, isEditLocked && styles.teLocked)}
                onClick={open}
                aria-disabled={isEditLocked || undefined}
                title={isEditLocked ? "AI 작업 중 — 완료 후 수정할 수 있습니다" : undefined}
              >
                화자 지정 ▾
              </button>
            )}
          />
          <button className={styles.teActionClear} onClick={() => setSelected(new Set())}>
            선택 해제
          </button>
        </div>
      )}

      {/* 화자 재할당 직후 — 회의록 본문에 반영하려면 현재 유형으로 재작성이 필요(이름 매핑과 달리 자동 반영 X) */}
      {onRetypeNotes && lastUndo && !isEditLocked && selected.size === 0 && (
        <div className={styles.teReflectBar}>
          <span className={styles.teReflectMsg}>
            화자를 바꿨어요 — 회의록 본문에 반영하려면 다시 작성이 필요해요.
          </span>
          <button className={styles.teReflectBtn} onClick={() => void onRetypeNotes(currentType)}>
            회의록 다시 쓰기
          </button>
        </div>
      )}
    </div>
  );
}
