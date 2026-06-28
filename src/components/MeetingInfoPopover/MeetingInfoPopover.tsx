import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useSession } from "@/contexts/SessionContext";
import { usePopover } from "../SpeakerPicker/usePopover";
import { loadMeetingMeta } from "@/utils/meetingMeta";
import AttendeeEditor from "../AttendeeEditor";
import styles from "./MeetingInfoPopover.module.css";

/**
 * 회의 정보(제목·시간·사전 정보·참석자) 조회·수정 팝오버. 세션 화면 탭바 우측 버튼으로 진입.
 *
 * 흩어져 있던 회의 메타를 상단 한 곳에 모아 발견성을 높인다. 특히 "초기에 참석자를 안 넣어
 * 나중에 어디서 추가하는지 못 찾던" 문제를 해결 — 참석자 편집은 여기로 일원화한다.
 * 제목은 updateTitle, 참석자는 updateAttendees로 meeting.json + context를 함께 갱신해
 * 화자 매칭·전사본의 이름 후보가 즉시 같은 목록을 본다(prop 반응). 시간·사전 정보는 조회 전용.
 */
interface MeetingInfoPopoverProps {
  sessionPath: string;
}

export default function MeetingInfoPopover({ sessionPath }: MeetingInfoPopoverProps) {
  const { meeting, updateTitle, updateAttendees } = useSession();

  const [titleDraft, setTitleDraft] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [time, setTime] = useState("");
  const [agenda, setAgenda] = useState("");

  // 외부 클릭으로 닫히면 input이 unmount돼 onBlur가 안 불릴 수 있어 제목 편집이 유실된다.
  // ref로 최신 draft를 들고, 팝오버가 닫힐 때(usePopover onClose)도 커밋한다.
  const titleDraftRef = useRef("");
  const commitTitle = () => {
    const t = titleDraftRef.current.trim();
    if (t && t !== (meeting?.title ?? "")) void updateTitle(t);
  };

  const { isOpen, open, close, popoverStyle, popoverRef } = usePopover(commitTitle);

  const setTitle = (v: string) => {
    titleDraftRef.current = v;
    setTitleDraft(v);
  };

  // 열 때 meeting.json에서 최신값을 읽는다(기존 세션은 context.attendees가 비어 있으므로 파일이 진실).
  const handleOpen = async (e: ReactMouseEvent<HTMLElement>) => {
    open(e);
    const meta = await loadMeetingMeta(sessionPath);
    setTitle(meta?.title ?? meeting?.title ?? "");
    setAttendees(meta?.attendees ?? []);
    setTime(meta?.time ?? "");
    setAgenda(meta?.agenda ?? "");
  };

  const handleAddAttendee = (name: string) => {
    if (attendees.includes(name)) return;
    const next = [...attendees, name];
    setAttendees(next);
    void updateAttendees(next);
  };

  const handleRemoveAttendee = (index: number) => {
    const next = attendees.filter((_, i) => i !== index);
    setAttendees(next);
    void updateAttendees(next);
  };

  return (
    <>
      <button className={styles.miTrigger} onClick={handleOpen} title="회의 정보 보기·수정">
        ℹ️ 회의 정보
      </button>
      {isOpen && (
        <div className={styles.miPopover} ref={popoverRef} style={popoverStyle}>
          <div className={styles.miHeader}>
            <span className={styles.miHeaderTitle}>회의 정보</span>
            <button className={styles.miClose} onClick={close} aria-label="닫기">
              ×
            </button>
          </div>

          <div className={styles.miField}>
            <span className={styles.miLabel}>제목</span>
            <input
              className={styles.miInput}
              value={titleDraft}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitTitle();
                  e.currentTarget.blur();
                }
              }}
              placeholder="회의 제목"
            />
          </div>

          {time && (
            <div className={styles.miField}>
              <span className={styles.miLabel}>시간</span>
              <span className={styles.miValue}>{time}</span>
            </div>
          )}

          <div className={styles.miField}>
            <AttendeeEditor
              attendees={attendees}
              onAdd={handleAddAttendee}
              onRemove={handleRemoveAttendee}
              alwaysExpanded
            />
          </div>

          {agenda && (
            <div className={styles.miField}>
              <span className={styles.miLabel}>사전 정보</span>
              <div className={styles.miAgenda}>{agenda}</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
