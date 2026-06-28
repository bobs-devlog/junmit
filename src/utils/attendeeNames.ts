// 참석자 이메일 → 표시 이름 해결 + 매핑 캐시 read/write.
//
// Google 캘린더는 참석자 displayName을 비워 보내는 경우가 많아(EventKit이 이메일로 fallback),
// 이메일을 안정 식별자로 삼아 이름을 단계적으로 해결한다. 사용자가 교정한 이름은 캐시에
// 영구 보관되어 다음 회의부터 자동 적용된다.

import { invoke } from "@tauri-apps/api/core";

export type NameCache = Record<string, string>;

// 이름이 어디서 왔는지 — UI가 "확정 vs 추정"을 구분 표시하는 데 사용.
//   cache: 사용자가 매핑(확정) / name: 캘린더 실제 이름(신뢰)
//   heuristic: 이메일에서 추정(틀릴 수 있음) / email: 미해결
export type NameSource = "cache" | "name" | "heuristic" | "email";

export interface ResolvedName {
  name: string;
  source: NameSource;
}

/** heuristic·email 소스는 "추정"(사용자 확인 필요), cache·name은 신뢰. */
export function isGuessed(source: NameSource): boolean {
  return source === "heuristic" || source === "email";
}

/**
 * 이메일 local-part 휴리스틱 — 첫 토큰(`. _ -` 분리)을 capitalize.
 * 예: bobs.kim@x.com → "Bobs", john_doe@x.com → "John". 표준 이메일에서 first name 추정.
 */
export function heuristicName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[._-]/)[0] ?? "";
  if (!first) return email;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * 표시 이름 결정 우선순위:
 *   ① 캐시 hit (사용자가 교정한 이름)
 *   ② EKParticipant.name 원시값 — 이메일꼴이 아니면 실제 이름으로 간주
 *   ③ 이메일 휴리스틱
 *   ④ 이메일 그대로
 */
export function resolveAttendeeName(
  email: string,
  rawName: string | undefined,
  cache: NameCache
): ResolvedName {
  const cached = cache[email]?.trim();
  if (cached) return { name: cached, source: "cache" };

  const raw = rawName?.trim();
  if (raw && !raw.includes("@")) return { name: raw, source: "name" };

  const local = email.split("@")[0] ?? "";
  if (local) return { name: heuristicName(email), source: "heuristic" };

  return { name: email, source: "email" };
}

export async function loadNameCache(): Promise<NameCache> {
  try {
    return await invoke<NameCache>("cmd_read_attendee_names");
  } catch {
    return {};
  }
}

export async function saveNameCache(cache: NameCache): Promise<void> {
  try {
    await invoke<void>("cmd_write_attendee_names", { names: cache });
  } catch {
    // 캐시 저장 실패는 치명적이지 않음 — 다음 해결 때 휴리스틱으로 fallback.
  }
}
