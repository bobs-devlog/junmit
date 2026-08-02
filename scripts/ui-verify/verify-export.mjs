// "파일로 저장" 실행 검증 — 기록 → 세션 → 회의록 탭 → 저장 버튼 → (모킹된) 저장 패널 →
// cmd_export_text_file 호출 내용(이름 치환) + 토스트 "Finder에서 보기" 액션까지.
import { chromium } from "playwright";
import { SHIM } from "./shim.mjs";

const SHOT = (name) => `${import.meta.dirname}/shot-export-${name}.png`;
function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exitCode = 1;
}
function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.addInitScript(SHIM);
await page.goto("http://localhost:1420");

// 기록 → 첫 카드(정산 플로우 개선 킥오프, 모든 단계 완료) → 세션 화면
await page.getByText("회의 기록").first().click();
await page.waitForSelector('[class*="sl-item"]:not([class*="sl-items"])');
await page.locator('[class*="sl-item"]:not([class*="sl-items"])').first().click();

// 회의록 탭으로 (기본 탭이 아닐 수 있음)
await page.getByText("회의록", { exact: true }).first().click().catch(() => {});
await page.waitForSelector("text=파일로 저장", { timeout: 10000 });
pass("세션 화면 회의록 탭 + '파일로 저장' 버튼 렌더");
await page.screenshot({ path: SHOT("1-button") });

await page.getByText("파일로 저장").click();
await page.waitForSelector("text=회의록을 저장했어요", { timeout: 5000 });
pass("저장 성공 토스트 표시");

const exportCalls = await page.evaluate(() =>
  window.__INVOKE_LOG.filter(([c]) => c === "cmd_export_text_file").map(([, a]) => a)
);
if (exportCalls.length === 1) pass("cmd_export_text_file 1회 호출");
else fail(`export 호출 기대 1회, 실제 ${exportCalls.length}`);

const { path, content } = exportCalls[0] ?? {};
if (path === "/fake/export/저장본.md") pass(`저장 패널 경로 사용: ${path}`);
else fail(`경로 기대 /fake/export/저장본.md, 실제 ${path}`);

// 이름 치환 확인 — 파일엔 SPEAKER_00이 아니라 Bobs가 쓰여야 함 (복사와 동일한 치환본)
if (content?.includes("Bobs") && !content?.includes("SPEAKER_00")) {
  pass("저장 내용은 이름 치환본 (SPEAKER_00 → Bobs)");
} else {
  fail(`치환 실패 — content 발췌: ${JSON.stringify((content ?? "").slice(0, 120))}`);
}

// 제목 헤딩 — 픽스처 본문은 "# 정산 플로우 개선 킥오프"로 시작(이미 H1)하므로 중복 삽입이 없어야 함
const h1Count = (content ?? "").split("\n").filter((l) => l.startsWith("# ")).length;
if (h1Count === 1) pass("제목 H1 1개 (이미 H1인 본문에 중복 삽입 없음)");
else fail(`H1 기대 1개, 실제 ${h1Count}개`);

// 토스트 액션 → Finder에서 보기
await page.getByText("Finder에서 보기").click();
await page.waitForTimeout(200);
const revealCalls = await page.evaluate(() =>
  window.__INVOKE_LOG.filter(([c]) => c === "cmd_reveal_in_finder").map(([, a]) => a.path)
);
if (revealCalls[0] === "/fake/export/저장본.md") pass("토스트 액션 → cmd_reveal_in_finder(저장 경로)");
else fail(`reveal 호출: ${JSON.stringify(revealCalls)}`);
await page.screenshot({ path: SHOT("2-toast") });

await browser.close();
console.log(process.exitCode ? "\n=== 실패 있음 ===" : "\n=== 전부 통과 ===");
