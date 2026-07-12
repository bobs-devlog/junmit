import { useState, useEffect } from "react";
import { usePopover } from "../SpeakerPicker/usePopover";
import { useSession } from "@/contexts/SessionContext";
import { loadVerificationReport } from "@/utils/verificationReport";
import type { VerificationReport } from "@/utils/verificationReport";
import styles from "./VerificationReceipt.module.css";

// 근거 "L372-373" → 첫 라인 번호(1-based). 형식이 아니면 null (클릭 불가 plain 표기).
function parseEvidenceLine(evidence: string): number | null {
  const m = /L(\d+)/.exec(evidence);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 회의록 검증 "영수증" — 검증 단계(자기검증)가 회의록에 적용한 교정 내역 칩 + 팝오버.
 * 회의록 탭 툴바에 노출. notes_verification_report.json이 있고 적용 1건 이상일 때만 렌더
 * (없으면 null — 검증 껐거나 고칠 게 없던 세션은 조용히 숨음).
 *
 * 팝오버 내 내비게이션 (클릭 후 팝오버 닫음):
 *   근거(L{n}) 클릭 → 전사본 탭 전환 + 해당 라인 스크롤 (Context requestTranscriptLine)
 *   항목 본문 클릭 → 회의록 본문 내 수정 문장으로 스크롤 (onNavigateToText — best-effort,
 *                    사용자가 편집해 문장이 사라졌으면 조용히 no-op)
 * 본문 인라인 하이라이트는 하지 않는다 — 데이터는 작성 시점 스냅샷이라 사용자가 회의록을
 * 편집해도 그대로 두면 된다(라인 매칭 없음). 조회 전용이므로 편집 잠금과 무관.
 */
interface VerificationReceiptProps {
  sessionPath: string;
  // 회의록 본문에서 해당 텍스트(after)로 스크롤 — 렌더 영역을 아는 NotesPreview가 구현을 담당.
  onNavigateToText?: (text: string) => void;
}

export default function VerificationReceipt({
  sessionPath,
  onNavigateToText,
}: VerificationReceiptProps) {
  const [report, setReport] = useState<VerificationReport | null>(null);
  const { isOpen, open, close, popoverStyle, popoverRef } = usePopover();
  // notesRefreshKey — 검증 완료(verify 신호)의 회의록 탭 스코프 재로드. phase_done 시점엔
  // report가 아직 없으므로(검증이 그 뒤에 씀) 이 키가 칩을 뒤늦게 나타나게 하는 유일한 경로.
  const { requestTranscriptLine, notesRefreshKey } = useSession();

  useEffect(() => {
    let cancelled = false;
    void loadVerificationReport(sessionPath).then((r) => {
      if (!cancelled) setReport(r);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionPath, notesRefreshKey]);

  if (!report) return null;

  return (
    <>
      <button
        type="button"
        className={styles.vrChip}
        onClick={open}
        title="검증 단계가 회의록을 전사와 대조해 교정한 내역을 봅니다"
      >
        {report.applied.length > 0
          ? `🔍 검증 ${report.applied.length}건`
          : `⚠ 화자 확인 ${report.mapping_warnings.length}건`}
      </button>
      {isOpen && (
        <div className={styles.vrPopover} ref={popoverRef} style={popoverStyle}>
          <div className={styles.vrHeader}>
            <span className={styles.vrHeaderTitle}>회의록 검증 내역</span>
            <button type="button" className={styles.vrClose} onClick={close} aria-label="닫기">
              ×
            </button>
          </div>

          {report.applied.length > 0 && (
            <div className={styles.vrList}>
              {report.applied.map((edit, i) => {
                const evidenceLine = edit.evidence ? parseEvidenceLine(edit.evidence) : null;
                return (
                  <div key={i} className={styles.vrItem}>
                    <div className={styles.vrItemHead}>
                      <span className={styles.vrType}>{edit.type}</span>
                      {/* 근거 — L{n} 형식이면 클릭 시 전사본 해당 라인으로 이동. 아니면 plain 표기. */}
                      {edit.evidence &&
                        (evidenceLine != null ? (
                          <button
                            type="button"
                            className={styles.vrEvidenceBtn}
                            onClick={() => {
                              requestTranscriptLine(evidenceLine);
                              close();
                            }}
                            title="전사본의 근거 발화로 이동"
                          >
                            전사 {edit.evidence}
                          </button>
                        ) : (
                          <span className={styles.vrEvidence} title="전사 근거 라인">
                            전사 {edit.evidence}
                          </span>
                        ))}
                    </div>
                    {/* 항목 본문 — 클릭 시 회의록 내 수정 문장으로 스크롤 (best-effort). */}
                    <button
                      type="button"
                      className={styles.vrChangeBtn}
                      onClick={() => {
                        onNavigateToText?.(edit.after);
                        close();
                      }}
                      title="회의록에서 이 문장으로 이동"
                    >
                      <span className={styles.vrChange}>
                        {/* "누락"(before 빈 문자열)은 보완된 내용만 — 화살표 없이 after 단독. */}
                        {edit.before && (
                          <>
                            <span className={styles.vrBefore} title={edit.before}>
                              {edit.before}
                            </span>
                            <span className={styles.vrArrow} aria-hidden="true">
                              →
                            </span>
                          </>
                        )}
                        <span className={styles.vrAfter} title={edit.after}>
                          {edit.after}
                        </span>
                      </span>
                      {edit.note && <span className={styles.vrNote}>{edit.note}</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {report.mapping_warnings.length > 0 && (
            <div className={styles.vrWarnings}>
              <div className={styles.vrWarningsTitle}>⚠ 화자 매핑 확인 필요</div>
              {report.mapping_warnings.map((w, i) => (
                <div key={i} className={styles.vrWarning}>
                  {w}
                </div>
              ))}
            </div>
          )}

          {/* 이동 안내 — 두 클릭 대상의 목적지를 한 줄로. 맨 아래 푸터(경고 섹션보다 아래):
              내역이 본문이고 조작 힌트는 부차 정보라 마지막에 둔다. 적용 내역이 없으면(경고만)
              클릭 대상이 없으므로 안내도 숨긴다. */}
          {report.applied.length > 0 && (
            <div className={styles.vrHint}>
              항목을 누르면 회의록의 해당 문장으로, 전사 L#을 누르면 근거 발화로 이동해요
            </div>
          )}
        </div>
      )}
    </>
  );
}
