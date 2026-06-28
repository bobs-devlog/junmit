import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import styles from "./NotesMarkdownView.module.css";

interface Props {
  markdown: string;
}

// GFM(GitHub Flavored Markdown) plugin — react-markdown은 기본적으로 CommonMark만 지원하므로
// table·task list(- [ ])·strikethrough·autolink를 쓰려면 remark-gfm 필요.
// 회의록의 결정사항/비교표(table)와 액션 아이템(task list)에 직접적 가치.
const REMARK_PLUGINS = [remarkGfm];

// 마크다운 anchor 클릭 시 Tauri webview 안에서 navigate되는 기본 동작 차단 후
// cmd_open_path로 OS 기본 브라우저에 위임 (macOS `open` 명령이 URL·파일 경로 모두 처리).
// rel="noopener noreferrer"는 만에 하나 새 창으로 열렸을 때의 보안 안전망.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          invoke("cmd_open_path", { path: href }).catch(() => {});
        }
      }}
    >
      {children}
    </a>
  ),
};

/**
 * 회의록 markdown 렌더링 전용 wrapper. 회의록 전용 스타일(헤더 border·accent 등) 일관성 보장.
 * 입력은 이미 SPEAKER_XX 치환된 markdown 문자열. 치환은 호출자(`substituteNames`)가 1회 수행 후
 * 결과를 NotesMarkdownView/CopyButton 등 여러 곳에 전달하는 패턴 — 변환 로직 단일 source.
 */
export default function NotesMarkdownView({ markdown }: Props) {
  return (
    <div className={styles.markdown}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {markdown}
      </Markdown>
    </div>
  );
}
