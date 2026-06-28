import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import SidebarNav from "@/components/Sidebar/SidebarNav";
import { useSidebarTarget } from "@/components/MainLayout";
import type { MeetingTypeOption } from "@/types";
import styles from "./MeetingTypes.module.css";

// 회의 유형 목록 (마스터). 카드 클릭 → 상세 화면. 보기·조정·편집·삭제는 상세에서.
export default function MeetingTypesListScreen() {
  const sidebarTarget = useSidebarTarget();
  const navigate = useNavigate();
  const [types, setTypes] = useState<MeetingTypeOption[]>([]);
  // 로드 완료 전엔 빈 상태("아직 회의 유형이 없습니다")가 잠깐 깜빡이지 않게 가드.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<MeetingTypeOption[]>("cmd_list_meeting_types")
      .then((t) => {
        if (alive) {
          setTypes(t);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      {sidebarTarget && createPortal(<SidebarNav />, sidebarTarget)}
      <div className={styles.mtMain}>
        <header className={styles.mtHeader}>
          <h1 className={styles.mtTitle}>회의 유형</h1>
          <p className={styles.mtDesc}>
            회의록 작성 가이드입니다. 녹음 전 유형을 고르거나, 자동 판단에 쓰입니다. 팀에 맞는
            유형을 자연어로 설명하면 AI가 가이드를 만들어 줍니다.
          </p>
        </header>

        <section className={styles.mtList}>
          <button
            type="button"
            className={styles.mtAddBtn}
            onClick={() => navigate("/meeting-types/new")}
          >
            + AI로 유형 추가
          </button>

          {loaded && types.length === 0 && (
            <p className={styles.mtEmpty}>
              아직 회의 유형이 없습니다. 모든 회의가 자유 형식으로 작성됩니다. 위 버튼으로 팀에 맞는
              유형을 추가해보세요.
            </p>
          )}

          {types.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={clsx(styles.mtCard, styles.mtCardClickable)}
              onClick={() => navigate(`/meeting-types/${encodeURIComponent(opt.id)}`)}
            >
              <div className={styles.mtCardHead}>
                <div className={styles.mtCardMeta}>
                  <span className={styles.mtCardLabel}>{opt.label}</span>
                  <span className={styles.mtCardDesc}>{opt.description}</span>
                </div>
              </div>
            </button>
          ))}
        </section>
      </div>
    </>
  );
}
