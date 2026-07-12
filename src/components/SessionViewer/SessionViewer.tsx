import { useState, useEffect } from "react";
import clsx from "clsx";
import Notes from "../Notes";
import TranscriptEditor from "../TranscriptEditor";
import SpeakerMergeSuggestions from "../SpeakerMergeSuggestions";
import MeetingInfoPopover from "../MeetingInfoPopover";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "@/contexts/SessionContext";
import styles from "./SessionViewer.module.css";

// 역순: 최종 결과물이 먼저. 화자 검증은 "전사본" 탭에 통합됨(별도 매칭 탭 없음 — 칩 인라인 + 요약 줄).
const TABS = [
  { id: "notes", label: "회의록", file: "meeting-notes.md" },
  { id: "transcript", label: "전사본", file: "transcript.txt" },
];

interface SessionViewerProps {
  sessionPath: string;
  attendees?: string[];
  // 단계 완료 시 자동 이동할 탭. mount/remount/focusSubtab 변경 시 우선 적용.
  focusSubtab?: string | null;
  // 사용자가 직접 탭 클릭 시 호출 — 부모가 focusSubtab을 clear해야 다음 단계까지 사용자 선택 유지.
  onUserTabChange?: () => void;
  onRetypeNotes?: (newType: string) => Promise<boolean>;
  // 무음("발화 없음")으로 diarize·회의록을 건너뛴 세션 — 전용 빈 상태 + escape hatch 표시.
  noSpeech?: boolean;
  onForceCompose?: () => void;
}

/**
 * 세션 뷰 컨테이너. 탭 전환 + 파일 가용 여부 체크만 담당.
 * 각 탭의 콘텐츠·편집·툴바는 전용 컴포넌트(Notes, TranscriptEditor)가 자체 관리.
 * AI 패널 진입점은 WorkArea 우측 끝의 absolute 토글 버튼이 책임.
 */
export default function SessionViewer({
  sessionPath,
  attendees = [],
  focusSubtab = null,
  onUserTabChange,
  onRetypeNotes,
  noSpeech = false,
  onForceCompose,
}: SessionViewerProps) {
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  // 합치기 후 활성 탭을 remount해 매핑 표시를 갱신하기 위한 카운터(자식 key에 포함).
  const [mergeBump, setMergeBump] = useState(0);
  // 자동 탭 전환 안내 배너 — Context가 표시 상태 소유. refresh 신호로 인한 remount에도 유지.
  // isEditLocked: AI 분석 중 편집 잠금(Correcting||Composing 파생) — Context 단일 출처.
  // 활성 탭(viewerTab)도 Context 소유 — refresh 신호의 전체 remount가 사용자가 보던 탭을
  // 첫 가용 탭으로 되돌리지 않게 한다(예: 전사본에서 화자 매핑 중 assist 수정 반영).
  const {
    tabBanner,
    dismissTabBanner,
    isEditLocked,
    viewerTab: activeTab,
    setViewerTab: setActiveTab,
  } = useSession();

  // 어떤 파일이 있는지 확인
  useEffect(() => {
    const check = async () => {
      const result: Record<string, boolean> = {};
      for (const tab of TABS) {
        const data = await invoke<string>("cmd_read_session_file", {
          sessionPath,
          filename: tab.file,
        }).catch(() => null);
        result[tab.id] = data != null;
      }
      setAvailable(result);

      if (focusSubtab && result[focusSubtab]) {
        setActiveTab(focusSubtab);
        return;
      }

      // focusSubtab이 없을 때: 이미 선택된(가용한) 탭이 있으면 보존한다. 사용자가 탭을 클릭하면
      // onUserTabChange가 focusSubtab을 clear하는데, 그 clear가 이 effect를 재실행시켜 방금 클릭한
      // 탭을 "첫 가용 탭" fallback이 덮어쓰던 버그(한 번에 안 넘어감)를 막는다. prev가 없거나
      // 더 이상 가용하지 않을 때만(초기 마운트·remount) 첫 가용 탭으로 떨어진다. viewerTab이
      // Context 소유라 refresh remount에도 prev가 살아남아 사용자가 보던 탭이 유지된다.
      setActiveTab((prev) =>
        prev && result[prev] ? prev : (TABS.find((t) => result[t.id])?.id ?? null)
      );
    };
    check();
  }, [sessionPath, focusSubtab, setActiveTab]);

  const hasAnyFile = Object.values(available).some(Boolean);

  if (!hasAnyFile) {
    // 무음 세션 — diarize·회의록을 건너뛴 상태. 데이터는 보존되어 있어 escape hatch로 복구 가능.
    if (noSpeech) {
      return (
        <div className={styles.svNoSpeech}>
          <div className={styles.svNoSpeechTitle}>녹음에서 발화를 찾지 못했어요</div>
          <p className={styles.svNoSpeechDesc}>
            무음이거나 너무 짧은 녹음일 수 있습니다. 회의록으로 작성할 내용이 없어 이후 단계를
            건너뛰었습니다.
          </p>
          {onForceCompose && (
            <button type="button" className="btn btn-secondary" onClick={onForceCompose}>
              그래도 회의록 작성하기
            </button>
          )}
        </div>
      );
    }
    return <div className="sv-empty">아직 생성된 데이터가 없습니다.</div>;
  }

  const renderContent = () => {
    // key에 mergeBump 포함 — 합치기 후 활성 탭이 remount되어 갱신된 speaker_mapping.json을 재로드한다.
    // 알려진 한계(수용): 회의록을 편집 모드로 미저장 상태에서 합치기를 누르면 remount로 그 편집분이
    // 버려진다. 모든 탭 즉시 동기를 택한 대가이며, 화자 정리는 보통 본문 편집 전에 하므로 경합이 드물다.
    if (activeTab === "notes") {
      return (
        <Notes key={`notes-${mergeBump}`} sessionPath={sessionPath} onRetypeNotes={onRetypeNotes} />
      );
    }
    if (activeTab === "transcript") {
      return (
        <TranscriptEditor
          key={`transcript-${mergeBump}`}
          sessionPath={sessionPath}
          attendees={attendees}
          onRetypeNotes={onRetypeNotes}
        />
      );
    }
    return <div className="sv-empty">파일이 없습니다.</div>;
  };

  return (
    <div className={styles.sessionViewer}>
      <div className={styles.svToolbar}>
        <div className={styles.svTabs}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={clsx(
                styles.svTab,
                activeTab === tab.id && styles.active,
                !available[tab.id] && styles.disabled
              )}
              onClick={() => {
                if (!available[tab.id]) return;
                setActiveTab(tab.id);
                // 사용자 명시 클릭 → 부모가 focusSubtab clear → 다음 단계 완료까지 이 선택 유지.
                onUserTabChange?.();
              }}
              disabled={!available[tab.id]}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <MeetingInfoPopover sessionPath={sessionPath} />
      </div>

      {tabBanner && (
        <div className={styles.svBanner} role="status" aria-live="polite">
          <div className={styles.svBannerText}>{tabBanner}</div>
          <button
            type="button"
            className={styles.svBannerClose}
            onClick={dismissTabBanner}
            aria-label="알림 닫기"
          >
            ×
          </button>
        </div>
      )}

      {/* 화자 합치기 제안 — 모든 탭 공통 상단. 과분할된 동일인 후보를 제안만 한다(자동 병합 X). */}
      <SpeakerMergeSuggestions
        sessionPath={sessionPath}
        attendees={attendees}
        isEditLocked={isEditLocked}
        onMerged={() => setMergeBump((b) => b + 1)}
      />

      <div className={styles.svBody}>{renderContent()}</div>
    </div>
  );
}
