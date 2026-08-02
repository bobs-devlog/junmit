// 회의 기록 검색 UI 실행 검증 — vite dev + TAURI shim(invoke 모킹)으로 전 상태 재현.
// 검증: 제목 즉시 필터 / 본문 일치 스니펫+배지(디바운스) / 제목·본문 중복 시 제목 우선 /
//       결과 카운트 / 결과 없음 / 지우면 복원.
import { chromium } from "playwright";

const BASE = "http://localhost:1420";
const SHOT = (name) => `${import.meta.dirname}/shot-${name}.png`;

import { SHIM } from "./shim.mjs";

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
await page.goto(BASE);

// 부트 게이트 통과 → 홈 → 사이드바 "회의 기록" (아이콘+라벨이 한 요소라 substring 매치)
await page.getByText("회의 기록").first().click();
await page.waitForSelector("input[type=search]");
pass("회의 기록 화면 도달 + 검색창 렌더");

const cards = () => page.locator('[class*="sl-item"]:not([class*="sl-items"])');
if ((await cards().count()) === 3) pass("전체 목록 3건");
else fail(`전체 목록 기대 3건, 실제 ${await cards().count()}`);
await page.screenshot({ path: SHOT("1-list") });

// 1) 제목 즉시 필터: "정산" 타이핑 직후(디바운스 전) s1만
await page.fill("input[type=search]", "정산");
const titleOnly = await cards().count();
if (titleOnly === 1) pass("제목 즉시 필터 (디바운스 전 1건)");
else fail(`제목 즉시 필터 기대 1건, 실제 ${titleOnly}`);

// 2) 디바운스 후 본문 일치 합류: s2(스니펫+회의록 배지), s1은 제목 우선이라 스니펫 없음
await page.waitForTimeout(600);
const afterBody = await cards().count();
if (afterBody === 2) pass("본문 일치 합류 (2건)");
else fail(`본문 합류 기대 2건, 실제 ${afterBody}`);

const snippets = page.locator('[class*="sl-snippet"]:not([class*="sl-snippet-text"])');
if ((await snippets.count()) === 1) pass("스니펫은 본문 일치 카드에만 1개 (제목 일치 s1은 없음)");
else fail(`스니펫 기대 1개, 실제 ${await snippets.count()}`);

const badge = await page.locator('[class*="sl-badge"]').textContent();
if (badge === "회의록") pass("출처 배지 '회의록'");
else fail(`배지 기대 '회의록', 실제 '${badge}'`);

const marks = await page.locator("mark").count();
if (marks >= 2) pass(`하이라이트 mark ${marks}개 (제목+스니펫)`);
else fail(`하이라이트 기대 2+개, 실제 ${marks}`);

const count = await page.locator('[class*="sl-count"]').textContent();
if (count?.includes("검색 결과 2건")) pass("카운트 줄 '검색 결과 2건'");
else fail(`카운트 줄 실제: '${count}'`);

// 제목 일치(s1)가 본문 일치(s2)보다 위
const firstTitle = await cards().first().locator('[class*="sl-title"]').textContent();
if (firstTitle?.includes("정산 플로우")) pass("정렬: 제목 일치가 먼저");
else fail(`정렬 기대 s1 먼저, 실제 첫 카드: '${firstTitle}'`);
await page.screenshot({ path: SHOT("2-search") });

// 3) 결과 없음
await page.fill("input[type=search]", "없는단어임");
await page.waitForTimeout(600);
const emptyMsg = await page.getByText("일치하는 회의가 없어요").count();
if (emptyMsg === 1) pass("결과 없음 상태");
else fail("결과 없음 메시지 미표시");
await page.screenshot({ path: SHOT("3-empty") });

// 4) 지우면 전체 복원
await page.fill("input[type=search]", "");
const restored = await cards().count();
if (restored === 3) pass("검색어 삭제 → 전체 목록 복원");
else fail(`복원 기대 3건, 실제 ${restored}`);

// shim이 받은 검색 invoke 검증 (2글자 하한: '없는단어임'과 '정산'만, 빈 질의는 없어야)
const log = await page.evaluate(() => window.__INVOKE_LOG.filter(([c]) => c === "cmd_search_sessions"));
const queries = log.map(([, a]) => a.query);
if (queries.every((q) => q.length >= 2)) pass(`본문 검색 invoke 질의: ${JSON.stringify(queries)}`);
else fail(`2글자 미만 질의가 invoke됨: ${JSON.stringify(queries)}`);

await browser.close();
console.log(process.exitCode ? "\n=== 실패 있음 ===" : "\n=== 전부 통과 ===");
