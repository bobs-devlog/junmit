import { useState, useEffect, useRef } from "react";
import clsx from "clsx";
import AttendeeList from "../AttendeeList";
import {
  DEFAULT_DURATION_MIN,
  MIC_PRIVACY_SETTINGS_URL,
  CALENDAR_PRIVACY_SETTINGS_URL,
  CALENDAR_APP_PATH,
  cliHasAgent,
} from "@/constants";
import { useSession } from "@/contexts/SessionContext";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDialog } from "@/contexts/DialogContext";
import { useToast } from "@/contexts/ToastContext";
import type { CalendarEvent, Meeting, MeetingTypeOption } from "@/types";
import {
  resolveAttendeeName,
  loadNameCache,
  saveNameCache,
  isGuessed,
  type NameCache,
  type NameSource,
} from "@/utils/attendeeNames";
import styles from "./MeetingSelector.module.css";

// `auto`는 templates 디렉토리에 파일이 없는 가상 옵션 — 사용자가 명시 유형을 고르지 않을 때 자동 판단.
// 회의 시작 시점에 LLM 판단을 default로 트리거. "자유 형식" 명시 선택은 회의록 검토 시(NotesPreview)만 노출 —
// 회의 시작 전에는 "이 회의는 정형 X" 사전 판단이 어려워 명시 선택 빈도 낮음.
const AUTO_OPTION: MeetingTypeOption = {
  id: "auto",
  label: "자동 판단",
  description: "AI가 내용 보고 판단",
};

interface MeetingSelectorProps {
  onSelect: (meeting: Meeting) => void;
}

// 작업 중 참석자 — 인덱스로 식별(동명 안전). email은 캘린더 유래만 보유(수동 추가는 null).
// source로 "확정(cache/name/수동) vs 추정(heuristic/email)"을 UI에 구분 표시.
interface AttendeeItem {
  name: string;
  email: string | null;
  source: NameSource;
}

export default function MeetingSelector({ onSelect }: MeetingSelectorProps) {
  const { cli } = useSession();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  // 캘린더 권한 status — 마운트 시 fetch 전에 조회해 not_determined에서 자동 다이얼로그를 피하고,
  // 상태별 안내 배너를 구동한다. "unknown"은 조회 자체 실패(드묾) → 기존처럼 fetch 시도로 폴백.
  const [calPermission, setCalPermission] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [attendees, setAttendees] = useState<AttendeeItem[]>([]);
  const [manualTitle, setManualTitle] = useState("");
  const [isManualMode, setIsManualMode] = useState(false);
  const [meetingType, setMeetingType] = useState("auto");
  // 전사본 교정 토글 — 기본 ON(opt-out), sticky 기억. 초기값 true로 마운트 로드 전 깜빡임 회피.
  const [detailedCorrection, setDetailedCorrection] = useState(true);
  // 회의록 검증 토글 — 전사본 교정과 동일 패턴(기본 ON·opt-out·sticky).
  const [notesVerification, setNotesVerification] = useState(true);
  // 사용자 templates 디렉토리에서 동적으로 로드. auto는 항상 첫 옵션으로 prepend.
  const [typeOptions, setTypeOptions] = useState<MeetingTypeOption[]>([AUTO_OPTION]);
  const [duration, setDuration] = useState<number | string>(DEFAULT_DURATION_MIN);
  // "not_determined" | "restricted" | "denied" | "authorized"
  const [micStatus, setMicStatus] = useState<string | null>(null);
  // 캘린더 notes 시드 + 사용자 편집 가능한 회의 컨텍스트.
  const [agenda, setAgenda] = useState("");
  const { confirm, alert } = useDialog();
  const toast = useToast();
  // "이름 추가" 입력칸 — 확인 모달에서 '참석자 추가' 선택 시 포커스를 줘 바로 입력하게 한다.
  const attendeeInputRef = useRef<HTMLInputElement>(null);
  // 창 복귀(focus) 시 실행할 자동 재조회 — 최신 state를 담아 stale closure를 피한다(매 렌더 갱신).
  const onWindowReturnRef = useRef<() => void>(() => {});
  // 이메일 → 이름 매핑 캐시 (영구).
  const [nameCache, setNameCache] = useState<NameCache>({});

  const enterManualMode = () => {
    setIsManualMode(true);
    setAttendees([]);
    setAgenda("");
  };

  const loadEvents = async (isRefresh = false) => {
    try {
      const fetchedEvents = await invoke<CalendarEvent[]>("cmd_fetch_calendar");
      setEvents(fetchedEvents);
      setCalendarError(null);
      if (isRefresh) setSelected(null);
      if (fetchedEvents.length === 0) {
        if (!isManualMode) enterManualMode();
      } else if (!isRefresh) {
        setIsManualMode(false);
      }
    } catch (e) {
      if (!isRefresh) enterManualMode();
      setCalendarError(`${e}`);
    } finally {
      if (!isRefresh) setIsLoading(false);
    }
  };

  // 마운트: 권한을 먼저 조회해 authorized일 때만 fetch(= not_determined에서 자동 OS 다이얼로그 회피).
  // 비authorized면 수동 입력 가능하게 두고 상태별 안내 배너만 노출. "unknown"(조회 실패)은 기존 폴백.
  useEffect(() => {
    void (async () => {
      const status = await invoke<string>("cmd_check_calendar_permission").catch(() => "unknown");
      setCalPermission(status);
      if (status === "authorized" || status === "unknown") {
        await loadEvents();
      } else {
        enterManualMode();
        setIsLoading(false);
      }
    })();
  }, []);

  // 안내 배너의 [캘린더 연동] — not_determined에서 cmd_fetch_calendar가 OS 다이얼로그를 띄운다.
  // 응답 후 권한을 재조회해 배너를 전환(허용→일정 목록, 거부→차단 배너).
  const connectCalendar = async () => {
    setIsLoading(true);
    await loadEvents();
    const status = await invoke<string>("cmd_check_calendar_permission").catch(() => "unknown");
    setCalPermission(status);
  };

  const openSettings = (url: string) => {
    invoke("cmd_open_path", { path: url }).catch(() => {});
  };

  // 빈 상태의 [캘린더 앱 열기] — 캘린더 앱을 열고 방법을 모달로 안내한다(클릭=의도 표명 시점에 노출).
  // 재조회는 창 복귀 시 자동(onWindowReturnRef)이 맡으므로 모달은 안내 전용 단일 버튼. 즉시 확인은
  // 빈 상태 헤더의 ↻새로고침으로 가능.
  const addCalendarAccount = async () => {
    openSettings(CALENDAR_APP_PATH);
    await alert({
      title: "캘린더 계정 추가",
      body: "macOS 캘린더 앱에 회의 일정을 추가하세요. Google 캘린더 등 외부 서비스로 일정을 관리한다면 '캘린더 > 계정 추가'에서 로그인하고, 아니면 캘린더에 일정을 직접 만들면 됩니다. 연동·동기화에 1~2분 걸릴 수 있는데, 일정이 추가되면 이 화면으로 돌아올 때 자동으로 불러옵니다.",
      confirmLabel: "확인",
    });
  };

  useEffect(() => {
    invoke<MeetingTypeOption[]>("cmd_list_meeting_types")
      .then((opts) => setTypeOptions([AUTO_OPTION, ...opts]))
      .catch(() => {});
  }, []);

  // 전사본 교정·회의록 검증 토글의 sticky 기본값 로드 — 마지막 선택을 초기 상태로.
  useEffect(() => {
    invoke<boolean>("cmd_get_detailed_default")
      .then(setDetailedCorrection)
      .catch(() => {});
    invoke<boolean>("cmd_get_verify_default")
      .then(setNotesVerification)
      .catch(() => {});
  }, []);

  // 토글 변경 → 즉시 sticky 기본값 저장(다음 회의에 적용). 저장 실패는 비치명적(현재 선택은 유지).
  const toggleDetailedCorrection = () => {
    const next = !detailedCorrection;
    setDetailedCorrection(next);
    void invoke("cmd_set_detailed_default", { on: next }).catch(() => {});
  };

  const toggleNotesVerification = () => {
    const next = !notesVerification;
    setNotesVerification(next);
    void invoke("cmd_set_verify_default", { on: next }).catch(() => {});
  };

  // 시스템 오디오 권한 선제 요청 — 캡처는 항상 시도하므로(설정 토글 없음), 마이크 권한 요청과 같은 시점
  // (회의 선택 화면)에 미요청이면 OS 프롬프트를 띄워 첫 원격회의 전에 권한을 정리한다. 마이크와 달리
  // 하드 블록은 안 함(거부 시 녹음은 마이크-only로 진행 — 캡처 여부는 녹음 중 레벨 미터로 확인).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let status: string | null = null;
      try {
        status = await invoke<string>("cmd_check_system_audio_permission");
      } catch {}
      if (cancelled || status !== "not_determined") return;
      try {
        await invoke("cmd_request_system_audio_permission");
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 참석자 이름 매핑 캐시 로드 (이메일 → 교정된 이름).
  useEffect(() => {
    loadNameCache()
      .then(setNameCache)
      .catch(() => {});
  }, []);

  // 창으로 돌아올 때 자동 재조회 — 캘린더 앱에서 일정을 추가하고 Junmit으로 돌아오면 손대지 않아도
  // 반영된다(외부 sync 1~2분 지연이라 돌아올 즈음 대개 들어와 있음). 단 "권한 있음 + 일정 0건 +
  // 사용자가 아직 아무것도 시작 안 함"일 때만 — 작업 중(선택·입력) 재조회는 선택 리셋 등 방해가 된다.
  useEffect(() => {
    onWindowReturnRef.current = () => {
      if (
        calPermission === "authorized" &&
        events.length === 0 &&
        selected === null &&
        attendees.length === 0 &&
        manualTitle.trim() === ""
      ) {
        void loadEvents(true);
      }
    };
  });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) onWindowReturnRef.current();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 마이크 권한 사전 조회·요청 — 녹음 직전이라 첫 회의 전에 권한을 정리한다.
  //   denied/restricted → 배너만 노출
  //   not_determined → cmd_request_mic_permission이 OS 다이얼로그 → 응답으로 micStatus 갱신
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let status: string | null;
      try {
        status = await invoke<string>("cmd_check_mic_permission");
      } catch {
        status = null;
      }
      if (cancelled) return;
      setMicStatus(status);

      // not_determined면 OS 권한 다이얼로그를 띄우고 응답으로 갱신.
      if (status === "not_determined") {
        try {
          status = await invoke<string>("cmd_request_mic_permission");
        } catch {}
        if (cancelled) return;
        setMicStatus(status);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectEvent = (idx: number) => {
    const evt = events[idx];
    setSelected(idx);
    // 캐시 → EKParticipant.name → 휴리스틱 → 이메일 순으로 표시 이름 해결. 이메일은 보관해
    // 인라인 편집 시 캐시에 귀속한다 (인덱스로 식별 — 동명이어도 안전).
    setAttendees(
      evt.attendees.map((a) => {
        const r = resolveAttendeeName(a.email, a.name, nameCache);
        return { name: r.name, email: a.email, source: r.source };
      })
    );
    setIsManualMode(false);
    setDuration(evt.duration_min || DEFAULT_DURATION_MIN);
    setAgenda(evt.notes ?? "");
  };

  const removeAttendee = (index: number) => {
    setAttendees((prev) => prev.filter((_, i) => i !== index));
  };

  const addAttendee = (name: string) => {
    if (name && !attendees.some((a) => a.name === name)) {
      // 수동 입력은 사용자가 직접 적은 확정 이름 → "추정" 표시 안 함.
      setAttendees((prev) => [...prev, { name, email: null, source: "name" }]);
    }
  };

  // 인라인 편집 — 표시 이름 변경 → 확정(source 승격, "추정" 표시 해제).
  // 캘린더 참석자(이메일 보유)는 캐시에 upsert해 다음 회의부터 자동 적용.
  const renameAttendee = (index: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const target = attendees[index];
    if (!target || trimmed === target.name) return;

    const nextSource: NameSource = target.email ? "cache" : "name";
    setAttendees((prev) =>
      prev.map((a, i) => (i === index ? { ...a, name: trimmed, source: nextSource } : a))
    );

    if (target.email) {
      const nextCache = { ...nameCache, [target.email]: trimmed };
      setNameCache(nextCache);
      saveNameCache(nextCache);
      // 수정도 캐시 저장되므로 확정과 동일하게 toast로 알린다.
      toast.success(`'${trimmed}' 이름을 저장했어요 — 다음 회의부터 자동으로 채워집니다.`);
    }
  };

  // 추정 이름이 맞을 때 — 수정 없이 현재 이름 그대로 확정(캐시 저장) → 다음 회의에도 적용.
  // 저장을 사용자가 인지하도록 toast로 알린다.
  const confirmAttendee = (index: number) => {
    const target = attendees[index];
    if (!target?.email) return;
    const nextCache = { ...nameCache, [target.email]: target.name };
    setNameCache(nextCache);
    saveNameCache(nextCache);
    setAttendees((prev) => prev.map((a, i) => (i === index ? { ...a, source: "cache" } : a)));
    toast.success(`'${target.name}' 이름을 저장했어요 — 다음 회의부터 자동으로 채워집니다.`);
  };

  const handleConfirm = async () => {
    // 참석자 미입력 시 부드러운 안내 — 막지 않고 정확도 향상을 알린 뒤 선택. 입력했으면 바로 진행.
    // (참석자는 화자 picker 후보 + /meeting 화자 식별의 핵심 입력. 녹음 후 회의 정보에서도 추가 가능)
    if (attendees.length === 0) {
      const proceed = await confirm({
        title: "참석자 없이 시작할까요?",
        body: (
          <>
            참석자를 입력하면 화자 이름을 더 정확히 매핑할 수 있어요.
            <br />
            녹음 후 <strong>회의 정보</strong>에서도 추가할 수 있습니다.
          </>
        ),
        confirmLabel: "이대로 시작",
        cancelLabel: "참석자 추가",
      });
      if (!proceed) {
        // 모달이 닫힌 뒤(포커스 복원 후) 입력칸에 포커스 — 바로 이름 입력 가능.
        setTimeout(() => attendeeInputRef.current?.focus(), 0);
        return;
      }
    }

    let title = "회의";
    let time: string | undefined;
    if (isManualMode) {
      title = manualTitle.trim() || "회의";
    } else if (selected !== null) {
      const evt = events[selected];
      title = evt?.title || "회의";
      time = evt?.time;
    }
    const dur = Math.max(1, parseInt(String(duration), 10) || DEFAULT_DURATION_MIN);
    const source = isManualMode ? "manual" : "calendar";
    // meeting.json·다운스트림은 이름 문자열만 사용 — 이메일은 캐시 귀속에만 쓰고 여기서 흘리지 않음.
    onSelect({
      title,
      attendees: attendees.map((a) => a.name),
      meetingType,
      duration: dur,
      agenda,
      time,
      source,
      detailedCorrection,
      notesVerification,
    });
  };

  if (isLoading) {
    return (
      <div className={styles.meetingSelector}>
        <div className="ms-loading">캘린더 조회 중...</div>
      </div>
    );
  }

  const hasSelection = selected !== null || isManualMode;
  // 일정 목록/새로고침 헤더는 실제로 fetch를 시도한(authorized 또는 조회 실패) 경우에만 노출.
  const calendarActive = calPermission === "authorized" || calPermission === "unknown";
  // 권한은 있는데 오늘 일정이 0건 — "진짜 빈 날"인지 "회의 캘린더 미연동"인지 EventKit으론 구분
  // 불가(iCloud가 기본 연동돼 카운트가 무의미). 단정 대신 차분한 연동 확인 힌트를 곁들인다.
  const calendarEmpty = calPermission === "authorized" && events.length === 0;

  return (
    <div className={styles.meetingSelector}>
      <div className={styles.msContent}>
        {(micStatus === "denied" || micStatus === "restricted") && (
          <div className={clsx("error-msg", styles.msError)}>
            <span className={styles.msErrorMsg}>
              마이크 권한이 차단되어 있습니다. 시스템 설정에서 허용하고 '종료 및 다시 열기'를
              선택해주세요.
            </span>
            <button
              type="button"
              className={styles.msErrorAction}
              onClick={async () => {
                try {
                  await invoke<void>("cmd_open_path", { path: MIC_PRIVACY_SETTINGS_URL });
                } catch {}
              }}
            >
              시스템 설정 열기
            </button>
          </div>
        )}

        {/* 권한 거부 sentinel은 calPermission 배너가 안내하므로 여기선 그 외 실제 조회 에러만 노출 */}
        {calendarError && !calendarError.includes("[NO_CALENDAR_PERMISSION]") && (
          <div className="error-msg">캘린더 조회 실패: {calendarError}</div>
        )}

        {/* 캘린더 안내 — 선택 기능이라 중립 info 톤. calPermission status로 분기. */}
        {calPermission === "not_determined" && (
          <div className={styles.msInfo}>
            <span className={styles.msInfoMsg}>
              Junmit은 macOS 캘린더에서 오늘 일정·참석자를 불러옵니다. 연동하면 회의 선택이
              빨라집니다.
            </span>
            <button
              type="button"
              className={styles.msInfoAction}
              onClick={() => void connectCalendar()}
            >
              캘린더 연동
            </button>
          </div>
        )}
        {(calPermission === "denied" || calPermission === "restricted") && (
          <div className={styles.msInfo}>
            <span className={styles.msInfoMsg}>
              캘린더 접근이 차단되어 있습니다. 시스템 설정에서 허용한 뒤 앱을 재시작해주세요.
            </span>
            <button
              type="button"
              className={styles.msInfoAction}
              onClick={() => openSettings(CALENDAR_PRIVACY_SETTINGS_URL)}
            >
              시스템 설정 열기
            </button>
          </div>
        )}
        {calendarActive && (
          <div className={styles.msEventsHeader}>
            <span className={styles.msSectionLabel}>
              {events.length > 0 ? "오늘 일정" : "오늘 일정 없음"}
            </span>
            <button
              type="button"
              className={styles.msEventsRefresh}
              onClick={() => loadEvents(true)}
            >
              ↻ 새로고침
            </button>
          </div>
        )}

        {/* 오늘 일정 0건 — 직접 입력은 아래 폼(autoFocus)이 자명하게 담당하므로 배너는 캘린더 경로만
            한 문장으로. "두면"이 외부 계정 연동과 로컬 직접 추가를 모두 포괄(강제 아닌 안내). */}
        {calendarEmpty && (
          <div className={styles.msInfo}>
            <span className={styles.msInfoMsg}>
              회의 일정을 macOS 캘린더 앱에 두면 제목·참석자를 자동으로 불러옵니다.
            </span>
            <button
              type="button"
              className={styles.msInfoAction}
              onClick={() => void addCalendarAccount()}
            >
              캘린더 앱 열기
            </button>
          </div>
        )}

        {events.length > 0 && (
          <div className={styles.msEvents}>
            {events.map((evt, i) => (
              <button
                key={i}
                className={clsx(styles.msEvent, selected === i && !isManualMode && styles.active)}
                onClick={() => handleSelectEvent(i)}
              >
                <span className={styles.msEventTime}>{evt.time}</span>
                <span className={styles.msEventTitle}>{evt.title}</span>
              </button>
            ))}
            <button
              className={clsx(styles.msEvent, styles.msManual, isManualMode && styles.active)}
              onClick={enterManualMode}
            >
              <span className={styles.msEventTime}>+</span>
              <span className={styles.msEventTitle}>직접 입력</span>
            </button>
          </div>
        )}

        {hasSelection && <div className={styles.msDivider} />}

        {isManualMode && (
          <input
            className="ms-input"
            type="text"
            placeholder="회의 제목"
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
            autoFocus
          />
        )}

        {/* 회의 유형 */}
        {hasSelection && (
          <>
            <div className={styles.msSectionLabel}>회의 유형</div>
            <div className={styles.msTypes}>
              {typeOptions.map((t) => (
                <button
                  key={t.id}
                  className={clsx(styles.msType, meetingType === t.id && styles.active)}
                  onClick={() => setMeetingType(t.id)}
                >
                  <span className={styles.msTypeLabel}>{t.label}</span>
                  <span className={styles.msTypeDesc}>{t.description}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* 참석자 관리 — 라벨 없는 섹션이라 wrap에 섹션 간격(margin-top)을 줘 다른 섹션과 정렬 */}
        {hasSelection && (
          <div className={styles.msAttendeeWrap}>
            <AttendeeList
              // 선택(회의) 전환 시 remount — 스크롤 위치·인라인 편집·페이드 단서를 새 목록 기준으로 초기화.
              key={isManualMode ? "manual" : `evt-${selected}`}
              attendees={attendees.map((a) => a.name)}
              emails={attendees.map((a) => a.email)}
              guessed={attendees.map((a) => isGuessed(a.source))}
              onAdd={addAttendee}
              onRemove={removeAttendee}
              onRename={renameAttendee}
              onConfirm={confirmAttendee}
              addInputRef={attendeeInputRef}
            />
          </div>
        )}

        {/* 예상 녹음 시간 */}
        {hasSelection && (
          <>
            <div className={styles.msSectionLabel}>예상 녹음 시간</div>
            <div className={styles.msDurationRow}>
              <input
                className={styles.msDurationInput}
                type="number"
                min="1"
                max="480"
                step="5"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
              <span className={styles.msDurationUnit}>분</span>
              <span className={styles.msDurationHint}>
                종료 시각이 되면 알림 — 직접 종료할 때까지 녹음은 계속됩니다
              </span>
            </div>
          </>
        )}

        {/* 전사본 교정(내부 필드명은 detailed_correction 유지) — 설정 토글(라벨 + 스위치 행).
            로컬 AI(mlx)는 교정 단계가 없어 효과 없는 설정이므로 숨긴다(값은 저장돼도 local_meeting.py가 안 읽음). */}
        {hasSelection && cliHasAgent(cli) && (
          <>
            <div className={styles.msSectionLabel}>전사본 교정</div>
            <button
              type="button"
              className={clsx(styles.msDetailed, detailedCorrection && styles.active)}
              role="switch"
              aria-checked={detailedCorrection}
              onClick={toggleDetailedCorrection}
            >
              <span className={styles.msDetailedText}>
                <span className={styles.msDetailedDesc}>
                  회의록과 별도로, 전사본의 음성 인식 오류를 교정해 읽기 편하게 만들어요. 회의록은
                  이 설정과 무관하게 같은 품질로 작성돼요
                </span>
                <span className={styles.msDetailedHint}>이 설정은 다음 회의에도 유지돼요</span>
              </span>
              <span className={styles.msDetailedSwitch} aria-hidden="true">
                <span className={styles.msDetailedKnob} />
              </span>
            </button>

            {/* 회의록 검증(내부 필드명은 notes_verification) — 전사본 교정과 동일 패턴의 설정 토글.
                mlx는 검증 단계가 없어 함께 숨긴다(같은 cliHasAgent 게이트 안). */}
            <div className={styles.msSectionLabel}>회의록 검증</div>
            <button
              type="button"
              className={clsx(styles.msDetailed, notesVerification && styles.active)}
              role="switch"
              aria-checked={notesVerification}
              onClick={toggleNotesVerification}
            >
              <span className={styles.msDetailedText}>
                <span className={styles.msDetailedDesc}>
                  작성된 회의록을 전사와 대조해 잘못 들어간 이름·날짜·누락을 걸러내요. 끄면 2~4분
                  빨라지지만 이 검증을 건너뛰어요
                </span>
                <span className={styles.msDetailedHint}>이 설정은 다음 회의에도 유지돼요</span>
              </span>
              <span className={styles.msDetailedSwitch} aria-hidden="true">
                <span className={styles.msDetailedKnob} />
              </span>
            </button>
          </>
        )}

        {/* 사전 정보 (아젠다·참고 링크·자료 등 — 회의 전 맥락) */}
        {hasSelection && (
          <>
            <div className={styles.msSectionLabel}>사전 정보</div>
            <textarea
              className={styles.msAgendaInput}
              value={agenda}
              onChange={(e) => setAgenda(e.target.value)}
              placeholder="아젠다, 참고 문서 링크, 사전 자료 등"
              rows={4}
            />
          </>
        )}
      </div>

      <div className={styles.msFooter}>
        <button
          className={clsx("btn", "btn-primary", "btn-large", styles.msConfirm)}
          onClick={handleConfirm}
          disabled={!hasSelection}
        >
          녹음 시작
        </button>
      </div>
    </div>
  );
}
