import { useMemo, useRef, useState } from "react";
import { parseBulkTerms } from "@/utils/vocabulary";
import styles from "./VocabularyEditor.module.css";

/**
 * 용어 사전 편집 — 전용 화면(VocabularyScreen)의 본문.
 *
 * 주 입력: 단일 칩(태그) 입력 — Enter/쉼표로 한 개, 목록 붙여넣기(쉼표·줄바꿈)는 자동 분리해 여러 개.
 * 보조 입력: "여러 개 한꺼번에 추가"(접이식 textarea) — 큰 목록을 커밋 전 검토하며 붙여넣을 때.
 * 칩 ×로 제거. 상태·영속화는 화면이 소유(presentational).
 *
 * 상단(설명·입력·일괄)은 고정, 칩 목록만 스크롤 — 사전이 길어져도 입력란이 항상 보인다.
 */
interface VocabularyEditorProps {
  terms: string[];
  loading: boolean;
  onAddTerms: (terms: string[]) => void;
  onRemove: (index: number) => void;
}

export default function VocabularyEditor({
  terms,
  loading,
  onAddTerms,
  onRemove,
}: VocabularyEditorProps) {
  const [draft, setDraft] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const canAdd = parseBulkTerms(draft).length > 0;

  // 칩 입력 버퍼를 용어로 확정 — 쉼표가 섞여 있으면 분리. 빈 결과면 무시.
  const commit = () => {
    const parsed = parseBulkTerms(draft);
    if (parsed.length > 0) onAddTerms(parsed);
    setDraft("");
  };

  // 보조 일괄 입력 — 기존 목록과 비교해 실제 추가될 신규 개수 미리보기.
  const parsedBulk = useMemo(() => parseBulkTerms(bulkText), [bulkText]);
  const existingKeys = useMemo(() => new Set(terms.map((t) => t.toLowerCase())), [terms]);
  const newCount = useMemo(
    () => parsedBulk.filter((t) => !existingKeys.has(t.toLowerCase())).length,
    [parsedBulk, existingKeys]
  );

  const commitBulk = () => {
    if (parsedBulk.length === 0) return;
    onAddTerms(parsedBulk);
    setBulkText("");
    setBulkOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className={styles.veRoot}>
      <div className={styles.veHeader}>
        <p className={styles.veDescription}>
          회의에서 자주 나오는 기술·도구·도메인 용어를 등록하면 전사 정확도와 회의록 교정 품질이
          올라갑니다. 사람 이름은 참석자 목록에서 자동으로 가져오니 따로 안 넣어도 됩니다.
        </p>

        <div className={styles.veAddRow}>
          <input
            ref={inputRef}
            className={styles.veInput}
            type="text"
            placeholder="용어 입력 후 Enter · 목록은 붙여넣기 (쉼표·줄바꿈 자동 분리)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 또는 쉼표 → 확정. 쉼표는 입력에 남기지 않음(구분자 역할).
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              }
            }}
            onPaste={(e) => {
              // 구분자(쉼표·줄바꿈)가 있는 목록 붙여넣기 → 즉시 여러 개로 분리.
              // 단일 토큰 붙여넣기는 기본 동작(입력란 채우기)으로 둬서 이어 편집 가능.
              const text = e.clipboardData.getData("text");
              if (/[\n,]/.test(text)) {
                e.preventDefault();
                const parsed = parseBulkTerms(text);
                if (parsed.length > 0) onAddTerms(parsed);
                setDraft("");
              }
            }}
          />
          <button
            className="btn btn-primary btn-small"
            onClick={() => canAdd && commit()}
            aria-disabled={!canAdd}
          >
            추가
          </button>
        </div>

        <button
          className={styles.veBulkToggle}
          onClick={() => setBulkOpen((v) => !v)}
          aria-expanded={bulkOpen}
        >
          {bulkOpen ? "접기" : "여러 개 한꺼번에 추가"}
        </button>

        {bulkOpen && (
          <div className={styles.veBulk}>
            <textarea
              className={styles.veTextarea}
              placeholder={"여러 용어를 줄바꿈이나 쉼표로 구분해 붙여넣으세요."}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={6}
            />
            <div className={styles.veBulkActions}>
              <span className={styles.veBulkHint}>
                {parsedBulk.length === 0
                  ? "붙여넣은 용어가 여기 집계됩니다"
                  : `용어 ${parsedBulk.length}개 인식 · 신규 ${newCount}개 추가`}
              </span>
              <button
                className="btn btn-primary btn-small"
                onClick={() => newCount > 0 && commitBulk()}
                aria-disabled={newCount === 0}
              >
                {newCount > 0 ? `${newCount}개 추가` : "추가"}
              </button>
            </div>
          </div>
        )}

        {(loading || terms.length > 0) && (
          <div className={styles.veCount}>
            {loading ? "불러오는 중…" : `등록된 용어 ${terms.length}개`}
          </div>
        )}
      </div>

      <div className={styles.veTags}>
        {terms.map((term, index) => (
          <span key={`${term}-${index}`} className={styles.veTag}>
            {term}
            <button
              className={styles.veTagRemove}
              onClick={() => onRemove(index)}
              title="삭제"
              aria-label={`${term} 삭제`}
            >
              ×
            </button>
          </span>
        ))}
        {!loading && terms.length === 0 && (
          <span className={styles.veEmpty}>아직 등록된 용어가 없습니다</span>
        )}
      </div>
    </div>
  );
}
