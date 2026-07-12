// notes_verification_report.json 로드 유틸 — 회의록 검증(자기검증) 단계가 적용한 교정 "영수증".
//
// /meeting 스킬이 검증 적용이 1건 이상일 때만 Write하므로 파일이 없을 수 있다(검증 껐거나
// 고칠 게 없던 세션). 부재·파싱 실패·applied 0건은 모두 null — 회의록 탭 칩이 조용히 숨는다.
// 본문 인라인 하이라이트는 하지 않는다 — 사용자가 회의록을 편집해도 이 데이터는 작성 시점
// 스냅샷 그대로 두는 게 의도(transcript_text_edits와 달리 라인 매칭 없음).

import { invoke } from "@tauri-apps/api/core";

// 스킬이 쓰는 유형 값: "근거없음" | "누락" | "귀속" | "정도" | "병합".
// 스킬 드리프트에 관대하도록 string으로 두고 알 수 없는 유형도 그대로 표시한다.
export interface VerificationEdit {
  type: string;
  /** 수정 전 서술 — "누락"(회의록에 없던 내용 보완)이면 빈 문자열. */
  before: string;
  after: string;
  /** 전사 근거 라인 (예: "L372-373"). */
  evidence?: string;
  /** 한 줄 사유. */
  note?: string;
}

export interface VerificationReport {
  applied: VerificationEdit[];
  mapping_warnings: string[];
}

/**
 * 세션의 notes_verification_report.json을 로드.
 * 파일 부재·파싱 실패·applied 0건이면 null (칩 미표시 조건과 일치).
 */
export async function loadVerificationReport(
  sessionPath: string
): Promise<VerificationReport | null> {
  if (!invoke) return null;
  try {
    const text = await invoke<string>("cmd_read_session_file", {
      sessionPath,
      filename: "notes_verification_report.json",
    });
    if (!text) return null;
    const parsed = JSON.parse(text) as {
      applied?: unknown;
      mapping_warnings?: unknown;
    };
    const applied = (Array.isArray(parsed.applied) ? parsed.applied : [])
      .filter(
        (e): e is VerificationEdit =>
          !!e &&
          typeof e === "object" &&
          typeof (e as VerificationEdit).after === "string" &&
          typeof (e as VerificationEdit).type === "string"
      )
      // before 누락(스킬 드리프트)은 빈 문자열로 정규화 — "누락" 유형과 동일한 표시 경로.
      .map((e) => ({ ...e, before: typeof e.before === "string" ? e.before : "" }));
    const mapping_warnings = (
      Array.isArray(parsed.mapping_warnings) ? parsed.mapping_warnings : []
    ).filter((w): w is string => typeof w === "string");
    // 교정 0건이라도 매핑 의심 경고가 있으면 노출 — 화자 매칭에 중요한 신호라 버리지 않는다.
    if (applied.length === 0 && mapping_warnings.length === 0) return null;
    return { applied, mapping_warnings };
  } catch {
    return null;
  }
}
