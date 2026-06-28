import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/contexts/ToastContext";
import { buildSpawnRequest } from "@/utils/spawn";
import { killPty } from "@/utils/pty";
import type { SpawnRequest } from "@/types";

type Phase = "idle" | "generating" | "preview";

export interface CreateFields {
  name: string;
  about: string;
  output: string;
  existing: string[];
}

// 회의 유형 생성/조정의 "AI 대화 세션"을 캡슐화한 훅. 생성 화면·상세(조정) 화면이 공유한다.
// `/template` 스킬을 PTY로 띄우고, staging 결과를 신호로 받아 미리보기로 노출하며, 저장 시 확정한다.
// (마운트 시 stale staging·PTY 정리, 언마운트 시 PTY 정리)
export function useTemplateSession() {
  const { appDir, signalDir, cli } = useSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>("idle");
  const [staged, setStaged] = useState<string | null>(null);
  const [committable, setCommittable] = useState(false);
  const [spawnRequest, setSpawnRequest] = useState<SpawnRequest | null>(null);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [previewFull, setPreviewFull] = useState(false);

  const modeRef = useRef<"create" | "adjust">("create");
  const phaseRef = useRef(phase);
  const committableRef = useRef(committable);
  useEffect(() => {
    phaseRef.current = phase;
    committableRef.current = committable;
  });

  // 진입 시 옛 PTY·stale staging 정리, 이탈 시 PTY 정리.
  useEffect(() => {
    void killPty();
    invoke("cmd_clear_staged_meeting_type").catch(() => {});
    return () => {
      void killPty();
    };
  }, []);

  // template_ready 신호 — 첫 초안·매 다듬기 턴마다 옴. staging 결과를 읽어 미리보기 갱신 + 저장 가능.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("app:signal", (event) => {
      try {
        const sig = JSON.parse(event.payload) as { type: string };
        if (sig.type !== "template_ready") return;
        invoke<string | null>("cmd_read_staged_meeting_type")
          .then((content) => {
            if (content) {
              setStaged(content);
              setPhase("preview");
              setCommittable(true);
            }
          })
          .catch(() => {});
      } catch {
        /* 무시 */
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setStaged(null);
    setCommittable(false);
    setPreviewFull(false);
    setSpawnRequest(null);
    void killPty();
  }, []);

  const launch = useCallback(
    (requestJson: string) => {
      if (!appDir) {
        toast.show("앱이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.");
        return;
      }
      setCommittable(false);
      setTerminalCollapsed(false);
      invoke("cmd_write_template_request", { requestJson })
        .then(() => {
          setSpawnRequest(buildSpawnRequest(appDir, "/template", null, signalDir ?? "", cli));
        })
        .catch((e) => toast.show(`요청을 준비하지 못했습니다: ${e}`));
    },
    [appDir, signalDir, cli, toast]
  );

  // 생성 — 폼 입력으로 시작. generating 단계(좌측 진행 안내) → 첫 신호에 preview로.
  const launchCreate = useCallback(
    (fields: CreateFields) => {
      if (phaseRef.current !== "idle") return;
      modeRef.current = "create";
      setPhase("generating");
      launch(JSON.stringify({ mode: "create", ...fields }));
    },
    [launch]
  );

  // 조정 — 현재본을 즉시 미리보기에 띄우고(앱이 전달), 스킬은 변경 지시를 터미널에서 받는다.
  const launchAdjust = useCallback(
    (targetId: string, currentContent: string) => {
      if (spawnRequest != null) return;
      modeRef.current = "adjust";
      setStaged(currentContent);
      setPreviewFull(false);
      setPhase("preview");
      launch(JSON.stringify({ mode: "adjust", target: targetId }));
    },
    [launch, spawnRequest]
  );

  // 저장 — staging 결과를 commit(생성=신규/조정=덮어쓰기). 성공 시 세션 reset + true 반환.
  const save = useCallback(
    async (labelForToast: string): Promise<boolean> => {
      if (!committable) return false;
      try {
        await invoke<string>("cmd_commit_meeting_type", {
          overwrite: modeRef.current === "adjust",
        });
        toast.show(`"${labelForToast}" 유형을 저장했습니다.`);
        reset();
        return true;
      } catch (e) {
        toast.show(`저장하지 못했습니다: ${e}`);
        return false;
      }
    },
    [committable, toast, reset]
  );

  const cancel = useCallback(() => {
    invoke("cmd_clear_staged_meeting_type").catch(() => {});
    reset();
  }, [reset]);

  // PTY 비정상 종료. 저장 가능한 초안이 있으면 미리보기 유지(작업 손실 방지), 없으면 reset.
  const onPtyExit = useCallback(() => {
    if (phaseRef.current === "idle") return;
    if (committableRef.current) {
      toast.show("AI 연결이 끊겼어요. 지금까지 만든 내용은 저장할 수 있어요.");
      setSpawnRequest(null);
    } else {
      toast.show("AI 작업이 중단되었습니다. 다시 시도해주세요.");
      reset();
    }
  }, [toast, reset]);

  return {
    phase,
    staged,
    committable,
    spawnRequest,
    terminalCollapsed,
    previewFull,
    active: phase !== "idle" || spawnRequest != null,
    launchCreate,
    launchAdjust,
    save,
    cancel,
    onPtyExit,
    toggleTerminal: useCallback(() => setTerminalCollapsed((c) => !c), []),
    setPreviewFull,
  };
}
