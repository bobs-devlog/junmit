import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/contexts/ToastContext";
import { useSession } from "@/contexts/SessionContext";
import { loadSpeakerMapping, saveSpeakerMapping } from "@/utils/speakerMapping";
import { loadSpeakerSimilarity, dismissSimilarityPair, pairKey } from "@/utils/speakerSimilarity";
import { loadAttendees } from "@/utils/attendees";
import { extractSpeakerLabels } from "@/utils/transcript";
import SpeakerPicker from "../SpeakerPicker";
import type { SpeakerMapping, SpeakerSimilarity, SimilarityCandidate } from "@/types";
import styles from "./SpeakerMergeSuggestions.module.css";

interface SpeakerMergeSuggestionsProps {
  sessionPath: string;
  attendees: string[];
  // 교정/작성 중(Correcting/Composing) — 합치기·거절을 잠근다. SessionContext.isEditLocked 전달받음.
  isEditLocked: boolean;
  // 합치기 후 부모(SessionViewer)가 활성 탭을 remount해 라벨 표시를 갱신하도록.
  onMerged: () => void;
}

function speakerNum(sp: string): number {
  return parseInt(sp.replace("SPEAKER_", ""), 10);
}

/**
 * 화자 합치기 제안 바 — 모든 탭 공통 상단(SessionViewer 소유)에 표시된다.
 *
 * pyannote 과분할로 한 사람이 여러 SPEAKER로 쪼개진 후보쌍(speaker_similarity.json)을 음성 유사도로
 * 찾아 "이 두 화자가 같은 분인가요?"를 제안한다. 이 기능의 가치는 합치는 *동작*(이름 지정은 사용자가
 * 직접 해도 쉽다)이 아니라 **발견** — 화자가 많거나 한쪽이 짧은 발언뿐일 때 사람이 놓치기 쉬운
 * "동일인"을 음성으로 짚어주는 데 있다.
 *
 * **자동 병합은 하지 않는다**(잘못 합치면 복구 불가). 수락 시 두 SPEAKER에 같은 이름을 부여할 뿐이고,
 * 회의록·전사본은 표시 시점 치환으로 같은 이름으로 보인다(가역 — 이름을 바꾸거나 해제하면 원복).
 * 전사본 라벨 자체는 통합하지 않는다(통합은 비가역이라 잘못 합쳤을 때 되돌릴 수 없다). 거절은 숨김(영속).
 */
export default function SpeakerMergeSuggestions({
  sessionPath,
  attendees,
  isEditLocked,
  onMerged,
}: SpeakerMergeSuggestionsProps) {
  const toast = useToast();
  const { updateAttendees } = useSession();
  const [similarity, setSimilarity] = useState<SpeakerSimilarity | null>(null);
  const [mapping, setMapping] = useState<SpeakerMapping>({});
  // 참석자 후보 — prop이 진실, 비어 있으면(기존 세션 등) 파일에서 fallback.
  const [allAttendees, setAllAttendees] = useState<string[]>(attendees);
  // 전사본에 실제 등장하는 화자 라벨 집합 — 후보 라벨이 실재하는지 확인용.
  const [transcriptLabels, setTranscriptLabels] = useState<Set<string>>(new Set());

  // 매핑은 mount 시점에 읽는다. 상단 바에서 합치면 부모가 활성 탭을 remount해 반영하지만,
  // 반대로 전사본에서 칩 클릭으로 수동 매칭한 변경은 이 바에 즉시 반영되지 않는다(새로고침·재마운트 시 동기).
  // 그 경우 이미 같은 이름인 쌍에 카드가 잠시 남을 수 있으나, 합치기는 idempotent라 데이터는 안전. (수용된 한계)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [sim, map, corrected, raw] = await Promise.all([
        loadSpeakerSimilarity(sessionPath),
        loadSpeakerMapping(sessionPath),
        invoke<string>("cmd_read_session_file", {
          sessionPath,
          filename: "transcript_corrected.txt",
        }).catch(() => null),
        invoke<string>("cmd_read_session_file", {
          sessionPath,
          filename: "transcript.txt",
        }).catch(() => null),
      ]);
      if (cancelled) return;
      setSimilarity(sim);
      setMapping(map);
      setTranscriptLabels(new Set(extractSpeakerLabels(corrected || raw)));

      if (attendees && attendees.length > 0) {
        setAllAttendees(attendees);
      } else {
        const loaded = await loadAttendees(sessionPath);
        if (!cancelled && loaded.length > 0) setAllAttendees(loaded);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionPath, attendees]);

  // picker에서 입력한 새 이름을 명단에 추가(이름 지정 중 단발 추가).
  // ⚠️ 파일 최신 명단을 다시 읽어 병합한다. 컴포넌트 state(allAttendees)가 로드 전 빈 배열일 때
  // [...allAttendees, name]로 저장하면 기존 명단을 통째로 덮어써 참석자가 날아간다(updateAttendees는
  // 전체 교체이므로). 최신 파일 기준 병합으로 그 데이터 손실을 막는다.
  const handleAddAttendee = async (name: string) => {
    const latest = await loadAttendees(sessionPath);
    if (latest.includes(name)) return;
    void updateAttendees([...latest, name]);
  };

  // 라벨의 친화 표시 — 이름이 있으면 이름, 없으면 "참석자 N"(buildSpeakerLabels와 동일 규칙).
  const labelOf = (sp: string) => mapping[sp]?.name?.trim() || `참석자 ${speakerNum(sp)}`;

  // 한쪽만 이름이 있으면 그 이름(1클릭 합치기), 0개·2개(다름)면 null(이름 선택 picker).
  const oneSidedName = (c: SimilarityCandidate): string | null => {
    const na = mapping[c.a]?.name?.trim() || "";
    const nb = mapping[c.b]?.name?.trim() || "";
    const known = [na, nb].filter(Boolean);
    return known.length === 1 ? known[0] : null;
  };

  const visible = useMemo(() => {
    if (!similarity) return [];
    return similarity.candidates.filter((c) => {
      const key = pairKey(c.a, c.b);
      if (similarity.dismissed.includes(key)) return false; // 거절됨
      if (!transcriptLabels.has(c.a) || !transcriptLabels.has(c.b)) return false; // 전사본에 없는 라벨
      const na = mapping[c.a]?.name?.trim() || "";
      const nb = mapping[c.b]?.name?.trim() || "";
      if (na && nb && na === nb) return false; // 이미 같은 이름 = 합쳐진 상태
      return true;
    });
  }, [similarity, transcriptLabels, mapping]);

  const applyMerge = async (c: SimilarityCandidate, name: string) => {
    if (isEditLocked || !name) return;
    try {
      // 사용자가 "같은 분"이라 명시 선택한 이름 → 두 화자 모두 확정(confirmed=true).
      await saveSpeakerMapping(sessionPath, c.a, { name, confirmed: true });
      await saveSpeakerMapping(sessionPath, c.b, { name, confirmed: true });
      // 로컬 매핑 갱신 → 두 이름이 같아져 visible에서 빠지며 카드가 사라진다.
      setMapping((prev) => ({
        ...prev,
        [c.a]: { name, reason: prev[c.a]?.reason ?? "", confirmed: true },
        [c.b]: { name, reason: prev[c.b]?.reason ?? "", confirmed: true },
      }));
      onMerged(); // 활성 탭 remount → 회의록·전사본·화자매칭이 같은 이름으로 표시.
      toast.success(`✓ '${name}'(으)로 합쳤어요 — 회의록·전사본에 같은 이름으로 표시돼요`);
    } catch (e) {
      toast.error(`합치기 실패: ${e}`);
    }
  };

  const handleDismiss = async (c: SimilarityCandidate) => {
    if (isEditLocked) return;
    try {
      await dismissSimilarityPair(sessionPath, c.a, c.b);
      setSimilarity((prev) =>
        prev ? { ...prev, dismissed: [...prev.dismissed, pairKey(c.a, c.b)] } : prev
      );
    } catch (e) {
      toast.error(`처리 실패: ${e}`);
    }
  };

  if (!similarity || visible.length === 0) return null;

  return (
    <div className={styles.smsContainer}>
      {visible.map((c) => {
        const oneSided = oneSidedName(c);
        const pct = Math.round(c.similarity * 100);
        const key = pairKey(c.a, c.b);
        return (
          <div key={key} className={styles.smsCard}>
            <span className={styles.smsIcon} aria-hidden="true">
              💡
            </span>
            <span className={styles.smsText}>
              <strong>{labelOf(c.a)}</strong> · <strong>{labelOf(c.b)}</strong> — 같은 분일까요?
              <span className={styles.smsMeta}> 음성 유사도 {pct}%</span>
            </span>
            <span className={styles.smsActions}>
              {oneSided ? (
                <button
                  type="button"
                  className={styles.smsMerge}
                  aria-disabled={isEditLocked || undefined}
                  onClick={() => !isEditLocked && applyMerge(c, oneSided)}
                  title={`'${oneSided}'(으)로 두 화자를 합칩니다`}
                >
                  같은 분이에요
                </button>
              ) : (
                <SpeakerPicker
                  value=""
                  attendees={allAttendees}
                  onChange={(name) => applyMerge(c, name)}
                  onAddAttendee={handleAddAttendee}
                  speaker={`${labelOf(c.a)} · ${labelOf(c.b)} 합치기 — 이름 선택`}
                  disabled={isEditLocked}
                  trigger={(open) => (
                    <button
                      type="button"
                      className={styles.smsMerge}
                      aria-disabled={isEditLocked || undefined}
                      onClick={open}
                    >
                      같은 분이에요
                    </button>
                  )}
                />
              )}
              <button
                type="button"
                className={styles.smsDismiss}
                aria-disabled={isEditLocked || undefined}
                onClick={() => !isEditLocked && handleDismiss(c)}
              >
                아니요
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
