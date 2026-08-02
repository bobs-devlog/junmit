// 로컬 모델 "다운로드" 버튼의 의도 게이트 검증:
//  A. 설정 → AI 도구 → 로컬 AI → "다운로드" 클릭 → 다운로드 화면 도착 즉시 설치 자동 시작
//  B. 부트 강제 진입(/local-model, state 없음) → 자동 시작 없음 + "다른 AI 도구 선택" 출구 유지
import { chromium } from "playwright";
import { SHIM } from "./shim.mjs";

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exitCode = 1;
}
function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

// 공통 확장 shim — 로컬 모델 화면 픽스처 + cmd_check_deps를 상태 기반으로.
// mlxChosen 전이는 cmd_set_active_cli("mlx")가 만든다(시나리오 A의 라우팅 재현).
const LOCAL_SHIM = (bootDepsInstalled) => `
  window.__LOCAL_STATE = { mlxChosen: ${!bootDepsInstalled} };
  const baseInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    const S = window.__LOCAL_STATE;
    if (cmd === "cmd_set_active_cli") { if (args?.cli === "mlx") S.mlxChosen = true; return Promise.resolve(null); }
    if (cmd === "cmd_check_deps") {
      return Promise.resolve(S.mlxChosen ? { installed: false, missing: ["로컬 AI 모델"] } : { installed: true, missing: [] });
    }
    if (cmd === "cmd_detect_clis") {
      return Promise.resolve({ claude: true, claude_authed: true, codex: false, codex_authed: false, antigravity: false, antigravity_authed: false });
    }
    if (cmd === "cmd_check_local_model") return Promise.resolve(false);
    if (cmd === "cmd_get_local_model") return Promise.resolve("gemma-4-12b-4bit");
    if (cmd === "cmd_check_local_capable") return Promise.resolve({ ram_gb: 16, disk_free_gb: 100 });
    if (cmd === "cmd_list_local_models") return Promise.resolve([]);
    if (cmd === "cmd_run_install") { S.installStarted = true; return new Promise(() => {}); } // 진행 중 고정
    return baseInvoke(cmd, args);
  };
`;

const browser = await chromium.launch();

// ── 시나리오 A: 의도 진입 → 자동 시작 ──
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(SHIM);
  await page.addInitScript(LOCAL_SHIM(true));
  await page.goto("http://localhost:1420");

  await page.getByText("설정", { exact: false }).first().click();
  await page.getByText("변경", { exact: true }).click();
  await page.getByText("로컬 AI (무료)").click();
  await page.waitForSelector("text=다운로드"); // 변형 선택 화면의 버튼
  pass("A: 변형 화면 도달, 버튼 라벨 '다운로드'(구 '계속')");

  await page.getByRole("button", { name: "다운로드", exact: true }).click();
  // 도착 즉시 자동 시작 → cmd_run_install이 클릭 없이 호출돼야 함
  await page.waitForFunction(() => window.__LOCAL_STATE.installStarted, null, { timeout: 8000 });
  pass("A: 다운로드 화면 도착 즉시 설치 자동 시작 (cmd_run_install 무클릭 호출)");
  const installing = await page.getByText("준비 중...").count();
  if (installing >= 1) pass("A: 진행 UI 표시");
  else fail("A: 진행 UI 미표시");
  await page.close();
}

// ── 시나리오 B: 부트 강제 진입 → 자동 시작 금지 ──
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(SHIM);
  await page.addInitScript(LOCAL_SHIM(false)); // 부팅부터 mlx 선택 + 모델 없음
  await page.goto("http://localhost:1420");

  await page.waitForSelector("text=모델 다운로드", { timeout: 8000 }); // 시작 버튼 대기 상태
  pass("B: 부트 강제 진입 → 버튼 대기 화면(자동 시작 안 됨)");
  await page.waitForTimeout(800); // effect가 있었다면 이미 발화했을 시간
  const started = await page.evaluate(() => window.__LOCAL_STATE.installStarted === true);
  if (!started) pass("B: cmd_run_install 미호출 확인");
  else fail("B: 부트 진입인데 자동 시작됨 — 탈출구 무력화!");
  const escape = await page.getByText("다른 AI 도구 선택").count();
  if (escape >= 1) pass("B: '다른 AI 도구 선택' 탈출구 유지");
  else fail("B: 탈출구 버튼 없음");
  await page.close();
}

await browser.close();
console.log(process.exitCode ? "\n=== 실패 있음 ===" : "\n=== 전부 통과 ===");
