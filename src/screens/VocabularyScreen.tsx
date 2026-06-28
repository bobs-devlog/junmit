import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import VocabularyEditor from "@/components/VocabularyEditor";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import { loadVocabulary, mergeTerms, saveVocabulary } from "@/utils/vocabulary";

// 전역 용어 사전 편집 화면. 세션과 무관 — Home 사이드바의 "용어 사전"에서 진입.
// 상태를 화면이 소유하고 변경 시 즉시 영속화(단일 진실 원천 = app-support/vocabulary.json).
export default function VocabularyScreen() {
  const sidebarTarget = useSidebarTarget();
  const [terms, setTerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    loadVocabulary().then((t) => {
      if (alive) {
        setTerms(t);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // 변경 즉시 반영 + 영속화. 저장 실패는 조용히 무시 (다음 변경에서 재시도).
  const persist = useCallback((next: string[]) => {
    setTerms(next);
    saveVocabulary(next).catch(() => {});
  }, []);

  const handleAddTerms = useCallback(
    (incoming: string[]) => persist(mergeTerms(terms, incoming)),
    [terms, persist]
  );
  const handleRemove = useCallback(
    (index: number) => persist(terms.filter((_, i) => i !== index)),
    [terms, persist]
  );

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <VocabularyEditor
        terms={terms}
        loading={loading}
        onAddTerms={handleAddTerms}
        onRemove={handleRemove}
      />
    </>
  );
}
