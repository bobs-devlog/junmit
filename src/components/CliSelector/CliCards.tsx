import clsx from "clsx";
import type { Cli } from "@/types";
import { OPTIONS, type CliOption } from "./cliOptions";
import styles from "./CliSelector.module.css";

interface CliCardsProps {
  detecting: boolean;
  busy: boolean;
  // 현재 사용 중인 CLI ("사용 중" 칩) — 아직 선택한 적 없으면(온보딩) null.
  activeCliId: Cli | null;
  isReady: (id: Cli) => boolean;
  badgeTextFor: (option: CliOption) => string;
  onChoose: (id: Cli) => void;
}

// 1단계: AI 도구 선택 카드 목록. 준비도 판정·클릭 라우팅은 부모(CliSelector) 소유 —
// 여기는 표시와 클릭 전달만.
export default function CliCards({
  detecting,
  busy,
  activeCliId,
  isReady,
  badgeTextFor,
  onChoose,
}: CliCardsProps) {
  return (
    <>
      <p className={styles.selectSubtitle}>
        Junmit은 회의를 녹음·전사하고 AI가 회의록을 작성합니다. Claude·ChatGPT·Google AI 구독을
        쓰거나, 구독 없이 이 기기에서 도는 로컬 AI(무료)로 작성할 수 있어요. 하나만 고르세요.
      </p>
      {detecting && (
        <div className={styles.detectingRow}>
          <span className={styles.pollSpinner} aria-hidden="true" />
          설치된 AI 도구를 확인하는 중이에요… 잠시만 기다려주세요.
        </div>
      )}
      <div className={styles.cards}>
        {OPTIONS.map((option) => {
          const ready = isReady(option.id);
          const isActive = option.id === activeCliId;
          return (
            <button
              key={option.id}
              type="button"
              className={clsx(styles.choiceCard, isActive && styles.choiceCardActive)}
              onClick={() => onChoose(option.id)}
              aria-disabled={detecting || busy}
            >
              <div className={styles.cardBody}>
                <div className={styles.cardHead}>
                  <span className={styles.cardName}>
                    {option.name}
                    {isActive && (
                      <>
                        {" "}
                        <span className={styles.usingChip}>사용 중</span>
                      </>
                    )}
                  </span>
                  <span
                    className={clsx(styles.badge, ready ? styles.badgeOk : styles.badgeMissing)}
                  >
                    {badgeTextFor(option)}
                  </span>
                </div>
                <div className={styles.cardSub}>{option.subtitle}</div>
              </div>
              <span className={styles.chevron} aria-hidden="true">
                ›
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
