import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import SpeakerProfileManager from "@/components/SpeakerProfileManager";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import { useDialog } from "@/contexts/DialogContext";
import {
  loadSpeakerDb,
  saveSpeakerDb,
  getSpeakerProfileEnabled,
  setSpeakerProfileEnabled,
} from "@/utils/speakerDb";
import type { SpeakerDb } from "@/utils/speakerDb";

// 화자 사전 화면. 세션과 무관, Home 사이드바의 "화자 사전"에서 진입.
// 상태를 화면이 소유하고 변경 시 즉시 영속화(단일 진실 원천 = app-support/speaker_db.json).
// 목소리 샘플은 생체정보 성격이라 삭제는 확인 다이얼로그를 거친다(복구 불가).
export default function SpeakerProfileScreen() {
  const sidebarTarget = useSidebarTarget();
  const { confirm } = useDialog();
  const [db, setDb] = useState<SpeakerDb | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([loadSpeakerDb(), getSpeakerProfileEnabled()]).then(([loaded, on]) => {
      if (alive) {
        setDb(loaded);
        setEnabled(on);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleToggle = useCallback((on: boolean) => {
    setEnabled(on); // 낙관적 반영
    setSpeakerProfileEnabled(on).catch(() => setEnabled(!on));
  }, []);

  // 변경 즉시 반영 + 영속화. 저장 실패는 조용히 무시 (다음 변경에서 재시도).
  const persist = useCallback((next: SpeakerDb) => {
    setDb(next);
    saveSpeakerDb(next).catch(() => {});
  }, []);

  const handleRemovePerson = useCallback(
    async (name: string) => {
      if (!db) return;
      const ok = await confirm({
        title: "화자 삭제",
        body: `'${name}'의 목소리 샘플을 모두 삭제할까요? 다음 회의부터 이분을 자동으로 알아보지 못합니다.`,
        confirmLabel: "삭제",
        danger: true,
      });
      if (!ok) return;
      persist({ ...db, people: db.people.filter((p) => p.name !== name) });
    },
    [db, confirm, persist]
  );

  const handleRemoveAll = useCallback(async () => {
    if (!db) return;
    const ok = await confirm({
      title: "화자 사전 전체 삭제",
      body: `등록된 ${db.people.length}명의 목소리 샘플을 모두 삭제할까요? 복구할 수 없습니다.`,
      confirmLabel: "전체 삭제",
      danger: true,
    });
    if (!ok) return;
    persist({ ...db, people: [] });
  }, [db, confirm, persist]);

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <SpeakerProfileManager
        people={db?.people ?? []}
        enabled={enabled}
        loading={db === null}
        onToggle={handleToggle}
        onRemovePerson={handleRemovePerson}
        onRemoveAll={handleRemoveAll}
      />
    </>
  );
}
