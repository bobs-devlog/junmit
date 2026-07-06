// 회의록 등 markdown을 클립보드에 복사할 때 text/plain과 함께 text/html도 태운다.
// markdown만 복사하면 Confluence·Google Docs 같은 리치텍스트 편집기에 붙여넣을 때
// **, - [ ] 같은 마크다운 문법이 그대로 텍스트로 들어가 서식이 깨진다. HTML을 함께
// 제공하면 대상 편집기가 이를 우선 채택해 헤더·리스트·표 서식이 유지된다.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

export async function copyMarkdownRich(markdown: string): Promise<void> {
  const html = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: REMARK_PLUGINS }, markdown)
  );
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([markdown], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } catch {
    // webview가 multi-type ClipboardItem을 거부하는 경우의 안전망 — markdown만이라도 복사.
    await navigator.clipboard.writeText(markdown);
  }
}
