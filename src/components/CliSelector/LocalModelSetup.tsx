import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { LOCAL_MODEL_STANDARD, LOCAL_MODEL_HIGH, isLocalModelId } from "@/constants";
import { useToast } from "@/contexts/ToastContext";
import { useDialog } from "@/contexts/DialogContext";
import { LOCAL_VARIANTS, type LocalVariant, type LocalVariantId } from "./cliOptions";
import styles from "./CliSelector.module.css";

interface LocalModelSetupProps {
  busy: boolean;
  // mlx가 현재 활성 CLI인지 — "사용 중" 배지·삭제 가드 기준.
  mlxActive: boolean;
  onBack: () => void;
  // 변형 선택 확정 — 영속 저장·라우팅은 부모(proceed와 같은 결)가 담당.
  onProceed: (model: LocalVariantId, variantName: string) => Promise<void>;
  // 모델 삭제 후 부모의 모델 존재 여부(카드 배지·준비 판정) 재조회 트리거.
  onModelsChanged: () => void;
}

// 2단계(로컬 AI): CLI 설치/로그인 없이 모델 변형 선택 → 다음 화면에서 다운로드.
// 변형 상세 상태(선택·설치 목록·영속 선택·기기 사양)는 이 화면 전용이라 여기서 소유하고,
// 부모는 카드 배지용 "모델 존재 여부"만 들고 있는다.
export default function LocalModelSetup({
  busy,
  mlxActive,
  onBack,
  onProceed,
  onModelsChanged,
}: LocalModelSetupProps) {
  const toast = useToast();
  const { confirm } = useDialog();
  // 변형 선택 — null이면 RAM 기반 권장값을 따른다(24GB+ → 고품질, 그 외 표준).
  // 이미 설치된 변형이 있으면 그걸 초기 선택으로(재진입 시 기존 선택 유지).
  const [localVariant, setLocalVariant] = useState<LocalVariantId | null>(null);
  // 이 기기 사양(RAM·디스크 여유) — 권장·경고 분기.
  const [capability, setCapability] = useState<{ ram_gb: number; disk_free_gb: number } | null>(
    null
  );
  // 설치 확인된 변형 목록 — "시작"(즉시) vs "계속"(다운로드) 라벨과 미사용 변형 삭제 UI 기준.
  const [installedList, setInstalledList] = useState<LocalVariantId[]>([]);
  // 영속 선택 변형(local_model 파일) — 삭제 가드(사용 중 변형 삭제 불가) 기준.
  const [persisted, setPersisted] = useState<LocalVariantId | null>(null);

  // 설치 목록·영속 선택 조회 — 마운트와 변형 삭제 후 재사용.
  const refreshVariants = useCallback(() => {
    return Promise.all([
      invoke<string[]>("cmd_list_local_models").catch(() => [] as string[]),
      invoke<string>("cmd_get_local_model").catch(() => ""),
    ]).then(([list, selected]) => {
      const variants = list.filter(isLocalModelId);
      setInstalledList(variants);
      if (isLocalModelId(selected)) {
        setPersisted(selected);
        // 설치된 영속 선택이면 카드 초기 선택으로 이어받는다 (사용자가 이미 고른 카드는 안 덮음).
        if (variants.includes(selected)) setLocalVariant((cur) => cur ?? selected);
      }
    });
  }, []);

  useEffect(() => {
    void refreshVariants();
    invoke<{ ram_gb: number; disk_free_gb: number }>("cmd_check_local_capable")
      .then(setCapability)
      .catch(() => {});
  }, [refreshVariants]);

  // 권장 = RAM 기반 (24GB+ → 고품질, 그 외 표준). 선택 전이면 권장을 따른다.
  const recommended: LocalVariantId =
    capability && capability.ram_gb >= 24 ? LOCAL_MODEL_HIGH : LOCAL_MODEL_STANDARD;
  const effective = localVariant ?? recommended;
  const chosenVariant = LOCAL_VARIANTS.find((v) => v.id === effective)!;
  // 선택 변형이 실제 설치돼 있는지 — 버튼 라벨("시작" vs "계속"=다운로드) 기준.
  const variantReady = installedList.includes(effective);
  // mlx가 활성 CLI일 때만 영속 선택 변형이 "사용 중" — 삭제 불가·배지 표기 기준.
  // claude/codex 사용 중엔 로컬 모델이 전혀 안 쓰이므로 어느 변형이든 삭제 가능.
  // 설치 여부 게이트 — 전환 중 종료로 "선택은 qat인데 미설치"가 되면
  // 미설치 카드에 "사용 중"이 뜨는 모순 방지.
  const inUse = (id: LocalVariantId) => mlxActive && id === persisted && installedList.includes(id);
  const deletable = LOCAL_VARIANTS.filter((v) => installedList.includes(v.id) && !inUse(v.id));

  const deleteVariant = async (variant: LocalVariant) => {
    const ok = await confirm({
      title: `${variant.name} 모델 삭제`,
      body: `디스크에서 약 ${variant.size}를 확보합니다. 다시 사용하려면 새로 내려받아야 해요.`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("cmd_delete_local_model", { model: variant.id });
      toast.success(`${variant.name} 모델을 삭제했습니다 (${variant.size} 확보).`);
      // 방금 지운 변형이 선택된 카드로 남지 않게 — refresh가 남은 설치본(또는 권장값)으로 재선택한다.
      setLocalVariant((cur) => (cur === variant.id ? null : cur));
      void refreshVariants();
      onModelsChanged();
    } catch (e) {
      toast.error(`삭제하지 못했습니다: ${e}`);
    }
  };

  // 디스크 필요량 ≈ 기초 엔진(~2GB) + 선택 모델 용량 + 여유
  const diskNeed = effective === LOCAL_MODEL_HIGH ? 14 : 10;

  return (
    <>
      <p className={styles.selectSubtitle}>
        이 기기에서 도는 로컬 AI(Gemma)로 회의록을 작성합니다. 구독은 필요 없고,
        {variantReady
          ? " 선택한 모델은 이미 설치되어 있어요."
          : ` 모델(${chosenVariant.size})을 한 번만 내려받아요.`}{" "}
        녹음·전사·화자 구분·회의록 작성은 모두 동일하고, AI에게 추가 요청(대화로 다듬기)은
        Claude·Codex에서만 지원돼요.
      </p>
      <div className={styles.cards}>
        {LOCAL_VARIANTS.map((variant) => {
          const isRecommended = variant.id === recommended;
          const isActive = variant.id === effective;
          const underRam =
            capability && capability.ram_gb > 0 ? capability.ram_gb < variant.recommendRam : false;
          // 배지는 카드당 하나 — 사용 중(상태) > 설치됨(상태) > 메모리 부족(경고)
          // > 권장(조언). 설치된 변형에 다운로드 조언은 무의미, 동색 병렬은 어수선.
          let badge: { text: string; ok: boolean } | null = null;
          if (inUse(variant.id)) badge = { text: "사용 중", ok: true };
          else if (installedList.includes(variant.id)) badge = { text: "설치됨", ok: true };
          else if (underRam) badge = { text: "메모리 부족", ok: false };
          else if (isRecommended) badge = { text: "이 기기 권장", ok: true };
          return (
            <button
              type="button"
              key={variant.id}
              className={clsx(styles.choiceCard, isActive && styles.choiceCardActive)}
              onClick={() => setLocalVariant(variant.id)}
            >
              <div className={styles.cardBody}>
                <div className={styles.cardHead}>
                  <span className={styles.cardName}>
                    {variant.name} ({variant.size})
                  </span>
                  {badge && (
                    <span
                      className={clsx(
                        styles.badge,
                        badge.ok ? styles.badgeOk : styles.badgeMissing
                      )}
                    >
                      {badge.text}
                    </span>
                  )}
                </div>
                <div className={styles.cardSub}>{variant.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className={styles.install}>
        <div className={styles.installLabel}>
          {capability ? (
            <>
              이 기기: 메모리 {capability.ram_gb}GB · 여유 공간 {capability.disk_free_gb}GB
              {capability.ram_gb > 0 && capability.ram_gb < chosenVariant.recommendRam && (
                <>
                  <br />
                  ⚠️ 이 모델은 메모리 {chosenVariant.recommendRam}GB 이상을 권장해요 — 회의록 작성이
                  느리거나 불안정할 수 있어요.
                </>
              )}
              {capability.disk_free_gb > 0 && capability.disk_free_gb < diskNeed && (
                <>
                  <br />
                  ⚠️ 디스크 여유가 부족할 수 있어요(엔진·모델 합계 약 {diskNeed}GB 필요).
                </>
              )}
            </>
          ) : (
            "이 기기 사양을 확인하는 중…"
          )}
          {/* 미사용 변형 정리 — 갈아탄 뒤 남은 6.8~11GB를 회수할 유일한 진입점. */}
          {deletable.map((variant) => (
            <span key={variant.id}>
              <br />
              사용하지 않는 {variant.name} 모델({variant.size})이 남아 있어요.{" "}
              <button
                type="button"
                className={styles.link}
                onClick={() => void deleteVariant(variant)}
              >
                삭제해 공간 확보
              </button>
            </span>
          ))}
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          뒤로
        </button>
        <button
          type="button"
          className={clsx("btn btn-primary", busy && styles.btnDisabled)}
          aria-disabled={busy}
          onClick={() => void onProceed(effective, chosenVariant.name)}
          autoFocus
        >
          {variantReady ? "로컬 AI로 시작" : "계속"}
        </button>
      </div>
    </>
  );
}
