// Tauri IPC shim + 픽스처 — 브라우저에 주입해 앱을 "홈 진입 완료" 상태로 만든다.
// window.__TAURI_INTERNALS__.invoke를 가로채 커맨드별 픽스처를 돌려주고, 호출 내역을
// window.__INVOKE_LOG에 남겨(검증 스크립트가 "무엇을 백엔드에 넘겼는가"를 단정) 확인한다.
//
// 새 화면을 검증할 때 추가할 것: 그 화면이 마운트 시 호출하는 커맨드를 FIXTURES에 넣는다.
// (누락하면 invoke가 null을 반환해 화면이 로딩/에러 상태에 멈추므로, debug 덤프로 확인)
const SESSIONS = [
  { path: "/fake/s1", title: "정산 플로우 개선 킥오프", date: "2026-07-29", time: "14:00" },
  { path: "/fake/s2", title: "주간 스프린트 리뷰", date: "2026-07-22", time: "10:30" },
  { path: "/fake/s3", title: "모바일 챕터 위클리", date: "2026-07-15", time: "09:00" },
].map((s) => ({
  ...s,
  ai_polish: true,
  steps: { transcribed: true, diarized: true, corrected: true, notes_written: true, no_speech: false },
}));

// "정산" 검색 시: s1은 전사 일치(그러나 제목도 일치 → 제목 우선으로 스니펫 없어야 함),
// s2는 회의록 일치(스니펫+배지). s3는 불일치.
const BODY_HITS = {
  "정산": [
    { path: "/fake/s1", source: "transcript", snippet: "…정산 얘기부터 하시죠…" },
    { path: "/fake/s2", source: "notes", snippet: "…파트너 정산 오류 건은 다음 주 내로 처리하기로…" },
  ],
};

// 세션 화면(회의록 탭) 재현용 — cmd_read_session_file이 파일명별로 돌려줄 픽스처.
const SESSION_FILES = {
  "meeting.json": JSON.stringify({
    title: "정산 플로우 개선 킥오프",
    date: "2026-07-29",
    type: "note",
    attendees: ["Bobs"],
    agenda: "",
    source: "manual",
  }),
  "meeting-notes.md": "# 정산 플로우 개선 킥오프\n\n## 결정사항\n- SPEAKER_00: 정산 오류 건은 다음 주 내로 처리\n",
  "speaker_mapping.json": JSON.stringify({ SPEAKER_00: { name: "Bobs", confirmed: true } }),
  "transcript.txt": "[SPEAKER_00 0:12] 정산 얘기부터 하시죠\n",
};

const SHIM = `
  const SESSION_FILES = ${JSON.stringify(SESSION_FILES)};
  const FIXTURES = {
    cmd_get_signal_dir: "/fake/signal",
    cmd_get_active_cli: "claude",
    cmd_get_app_dir: "/fake/app",
    cmd_is_cli_chosen: true,
    cmd_check_deps: { installed: true, missing: [] },
    cmd_list_meeting_types: [],
    cmd_get_polish_default: true,
    cmd_get_verify_default: true,
    cmd_get_attendee_hint_seen: true,
    cmd_fetch_calendar: [],
    cmd_check_calendar_permission: "denied",
    cmd_get_calendar_connected: false,
    cmd_check_mic_permission: "authorized",
    cmd_check_system_audio_permission: "authorized",
    cmd_find_sessions: ${JSON.stringify(SESSIONS)},
  };
  const BODY_HITS = ${JSON.stringify(BODY_HITS)};
  window.__INVOKE_LOG = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  let cbId = 0;
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = ++cbId; window["_cb" + id] = cb; return id; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke(cmd, args) {
      window.__INVOKE_LOG.push([cmd, args]);
      if (cmd === "cmd_search_sessions") {
        return Promise.resolve(BODY_HITS[(args?.query ?? "").trim()] ?? []);
      }
      if (cmd === "cmd_read_session_file") {
        return Promise.resolve(SESSION_FILES[args?.filename] ?? null);
      }
      if (cmd === "plugin:dialog|save") {
        return Promise.resolve("/fake/export/저장본.md");
      }
      if (cmd in FIXTURES) return Promise.resolve(FIXTURES[cmd]);
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(++cbId);
      if (cmd.startsWith("plugin:notification|")) return Promise.resolve(false);
      if (cmd.startsWith("plugin:updater|")) return Promise.reject("shim: no updater");
      return Promise.resolve(null);
    },
  };
`;

export { SHIM, SESSIONS, BODY_HITS };
