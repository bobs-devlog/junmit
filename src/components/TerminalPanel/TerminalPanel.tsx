import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SpawnRequest } from "@/types";
import styles from "./TerminalPanel.module.css";

// 부모(WorkArea)가 drawer expand 시점에 focus()를 명시 호출 — display:none ↔ visible 전환 후
// 자동 focus가 안 가는 문제 해소.
export interface TerminalPanelHandle {
  focus: () => void;
}

const THEME = {
  background: "#0f0f0f",
  foreground: "#e0e0e0",
  cursor: "#4cc9f0",
  selectionBackground: "#4cc9f044",
  black: "#0f0f0f",
  red: "#f07070",
  green: "#70f0a0",
  yellow: "#f0d070",
  blue: "#4cc9f0",
  magenta: "#c070f0",
  cyan: "#70e0f0",
  white: "#e0e0e0",
};

// D2Coding 우선 — 한글이 영문 cell의 정확히 2배 폭으로 렌더링되어 claude code TUI(ink)의
// East Asian wide char 계산과 xterm.js cell 정렬이 일치. fallback은 시스템 monospace.
const TERMINAL_FONT =
  '"D2Coding", "SF Mono", Menlo, Monaco, "Courier New", "Apple SD Gothic Neo", "AppleGothic", "Malgun Gothic", monospace';

interface TerminalPanelProps {
  spawnRequest: SpawnRequest | null;
  onExit: () => void;
  // 사용자가 PTY에서 단독 Esc 누름 — Claude 응답 interrupt 의도 신호.
  // Claude Code TUI/CLI는 Stop hook을 정상 turn 종료에만 발동시키고 Esc는 잡지 않으며 OSC 신호도
  // 출력하지 않아(검증 완료) 외부에서 자동 감지할 표준 채널이 없음. 우리가 PTY stdin을 보고 있으므로
  // 사용자 키 입력에서 \x1b 단독 chunk를 잡는 게 유일한 실용 경로.
  onEscape?: () => void;
}

const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel(
  { spawnRequest, onExit, onEscape },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const listenersRef = useRef<UnlistenFn[]>([]);
  // onEscape는 mount-once useEffect 안에서 쓰여 stale closure 회피용 ref. 부모가 핸들러 교체해도 최신 참조.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => termRef.current?.focus(),
    }),
    []
  );

  // 터미널 초기화 (한 번만)
  useEffect(() => {
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      theme: THEME,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current!);
    fitAddon.fit();

    termRef.current = term;

    term.writeln("\x1b[36mJunmit\x1b[0m — AI 작업\r\n");
    term.focus();

    // 리사이즈 — drawer resize transition 중 여러 번 fire되므로 debounce로 안정화 후 1회 처리.
    // fit 후 term.refresh로 모든 cell 강제 redraw — claude code TUI(ink)와 xterm.js의 wide char
    // 폭 계산 불일치로 한글·따옴표 경계에 cell 잔류가 생기는 현상 우회.
    let resizeTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        fitAddon.fit();
        if (pending) {
          syncPendingView(pending);
        }
        const { rows, cols } = term;
        invoke<void>("cmd_pty_resize", { rows, cols }).catch(() => {});
        // 모든 visible cell 강제 redraw — fit 후 잔류 cell 복원.
        term.refresh(0, term.rows - 1);
      }, 60);
    });
    ro.observe(containerRef.current!);

    // WKWebView on macOS reports Hangul IME composition via inputType instead of composition* events.
    // xterm's default onData path misses replacement-style updates, so we keep the in-progress
    // syllable in `pending`, mirror it into `.composition-view`, and flush to the PTY on commit.
    let ptyChain: Promise<void> = Promise.resolve();
    const pty = (data: string) => {
      if (!data) return;
      ptyChain = ptyChain.then(() => invoke<void>("cmd_pty_input", { data }).catch(() => {}));
    };

    const compositionView = term.element?.querySelector(".composition-view") as HTMLElement | null;
    const syncPendingView = (text: string) => {
      if (!compositionView || !textarea) return;

      if (!text) {
        compositionView.textContent = "";
        compositionView.classList.remove("active");
        return;
      }

      compositionView.textContent = text;
      compositionView.classList.add("active");
      compositionView.style.left = textarea.style.left;
      compositionView.style.top = textarea.style.top;
      compositionView.style.height = textarea.style.height;
      compositionView.style.lineHeight = textarea.style.lineHeight;
      // Match the terminal font stack so the IME preview doesn't visibly jump on commit.
      compositionView.style.fontFamily = TERMINAL_FONT;
      compositionView.style.fontSize = textarea.style.fontSize || `${term.options.fontSize}px`;
    };

    // Hangul 범위: wk-hangul-ime(https://github.com/thedalbee/wk-hangul-ime) 참조.
    // xterm.js PR #5704 및 WebKit Bug #274700에서 논의된 표준 대응 범위 5개 블록.
    const isSingleKorean = (s: string): boolean => {
      if (!s || [...s].length !== 1) return false;
      const cp = s.codePointAt(0);
      if (cp === undefined) return false;
      return (
        (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
        (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
        (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
        (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
        (cp >= 0xd7b0 && cp <= 0xd7ff)
      ); // Hangul Jamo Extended-B
    };

    const textarea = term.textarea;
    let pending = "";
    let flushTimer: number | null = null;
    const setPending = (value: string) => {
      pending = value;
      syncPendingView(value);
    };
    const clearFlushTimer = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };
    const flushPending = () => {
      clearFlushTimer();
      if (!pending) return;
      const p = pending;
      setPending("");
      if (textarea) textarea.value = ""; // 숨김 textarea 누적 방지
      pty(p);
    };
    // 사용자가 조합 중 입력을 멈추면 매달린 문자가 남지 않도록 300ms 후 자동 flush.
    const scheduleFlush = () => {
      clearFlushTimer();
      flushTimer = window.setTimeout(flushPending, 300);
    };

    const onInput = (e: Event) => {
      const ie = e as InputEvent;
      if (ie.target !== textarea) return;
      const inputType = ie.inputType;
      const data = ie.data || "";

      if (inputType === "insertText" && isSingleKorean(data)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        flushPending();
        setPending(data);
        scheduleFlush();
      } else if (inputType === "insertReplacementText") {
        e.stopImmediatePropagation();
        e.preventDefault();
        setPending(data);
        scheduleFlush();
      } else if (inputType === "deleteContentBackward" && pending) {
        e.stopImmediatePropagation();
        e.preventDefault();
        setPending("");
        clearFlushTimer();
      }
    };
    document.addEventListener("input", onInput, true);

    const onBlur = () => flushPending();
    textarea?.addEventListener("blur", onBlur);

    const syncPendingOnCursorMove = term.onCursorMove(() => {
      if (pending) {
        syncPendingView(pending);
      }
    });

    // macOS 친화적 readline 단축키 매핑. Claude Code는 readline/emacs 바인딩을 따름.
    //   Shift+Enter      → LF (줄바꿈; 일반 Enter \r는 제출)
    //   Cmd+←/→          → Ctrl+A / Ctrl+E (줄 시작/끝)
    //   Option+←/→       → ESC+b / ESC+f (단어 단위 이동)
    //   Option+Backspace → ESC+DEL (앞 단어 삭제)
    //   Cmd+Backspace    → Ctrl+U (줄 시작까지 삭제)
    term.attachCustomKeyEventHandler((e) => {
      // IME 조합 중에는 xterm이 키를 처리하지 않도록 차단 (keyCode 229 = IME composition).
      // 조합된 문자는 onInput 경로로 들어오므로 keydown은 전부 막는 게 맞음.
      if (e.type === "keydown" && (e.keyCode === 229 || e.isComposing)) {
        return false;
      }
      if (e.type !== "keydown") return true;

      const { key, shiftKey, altKey, metaKey, ctrlKey } = e;
      let seq = null;

      if (key === "Enter" && shiftKey && !ctrlKey && !altKey && !metaKey) {
        seq = "\n";
      } else if (metaKey && !ctrlKey && !altKey) {
        if (key === "ArrowLeft") seq = "\x01";
        else if (key === "ArrowRight") seq = "\x05";
        else if (key === "Backspace") seq = "\x15";
      } else if (altKey && !ctrlKey && !metaKey) {
        if (key === "ArrowLeft") seq = "\x1bb";
        else if (key === "ArrowRight") seq = "\x1bf";
        else if (key === "Backspace") seq = "\x1b\x7f";
      }

      if (seq !== null) {
        // 브라우저가 textarea에 줄바꿈을 자동 삽입하면 xterm이 중복으로 읽어가므로 막는다.
        e.preventDefault();
        e.stopPropagation();
        flushPending();
        pty(seq);
        return false;
      }
      return true;
    });

    term.onData((data) => {
      // 조합 중인 한글이 xterm의 기본 처리 경로로 누출되면 중복 전송 방지.
      if (pending && data.length === 1 && isSingleKorean(data)) return;
      flushPending();
      pty(data);
      // 단독 Esc(\x1b 1 byte) — 사용자의 응답 중단 의도. 화살표키 등 escape sequence는
      // \x1b[A 같이 2+ bytes 한 chunk라 자동 제외됨. xterm.js는 키스트로크 단위로 chunk를 넘김.
      if (data === "\x1b") {
        onEscapeRef.current?.();
      }
    });

    return () => {
      document.removeEventListener("input", onInput, true);
      textarea?.removeEventListener("blur", onBlur);
      syncPendingOnCursorMove.dispose();
      clearFlushTimer();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      ro.disconnect();
      term.dispose();
    };
  }, []);

  // PTY 이벤트 리스너 등록 (한 번만)
  useEffect(() => {
    const setupListeners = async () => {
      const unData = await listen<string>("pty:data", (event) => {
        const binary = atob(event.payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        termRef.current?.write(bytes);
      });

      const unExit = await listen<unknown>("pty:exit", () => {
        termRef.current?.writeln("\r\n\x1b[90m[프로세스 종료]\x1b[0m");
        onExit?.();
      });

      listenersRef.current = [unData, unExit];
      if (!mounted) {
        unData();
        unExit();
      }
    };

    let mounted = true;
    setupListeners();

    return () => {
      mounted = false;
      listenersRef.current.forEach((unlisten) => unlisten());
    };
  }, [onExit]);

  // spawnRequest가 바뀌면 PTY 시작
  useEffect(() => {
    if (!spawnRequest) return;

    const term = termRef.current;
    if (!term) return;

    // 전체 리셋(RIS) — clear()는 버퍼만 비우고 터미널 상태(SGR·스크롤 영역·화면 모드)는
    // 남긴다. 직전 프로세스가 TUI였고 강제 종료라 화면 복원 시퀀스 없이 죽은 경우(AI 작업
    // 중단 등) 그 잔존 상태 위에 새 세션이 겹쳐 그려져 화면이 깨진다.
    term.reset();

    // 현재 xterm 크기로 PTY를 연다 — 크기 동기화를 ResizeObserver에만 맡기면 드로어가
    // 이미 열린 채 PTY만 교체되는 경로에서 리사이즈가 안 가 TUI가 80×24로 그려진다.
    invoke<void>("cmd_spawn_terminal", {
      command: spawnRequest.command || "bash",
      args: spawnRequest.args,
      rows: term.rows,
      cols: term.cols,
    }).catch((e) => {
      term.writeln(`\x1b[31m오류: ${e}\x1b[0m`);
      onExit?.();
    });
  }, [spawnRequest, onExit]);

  return (
    <main className={styles.terminalContainer}>
      <div className={styles.terminal} ref={containerRef} />
    </main>
  );
});

export default TerminalPanel;
