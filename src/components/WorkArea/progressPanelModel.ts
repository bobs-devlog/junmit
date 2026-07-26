// 진행 패널 셸·컨테이너 공유 데이터 모델. 컴포넌트 파일에 함수 export를 섞으면 fast refresh가
// 깨져 별도 모듈로 둔다.

// 단계 체크리스트 한 행. 단계는 앱 상태·파이프라인 마커 기반 결정론(모델 출력 추론 금지:
// 누락·순서 역전마다 보정이 늘어난다). hint는 진행(running) 행 아래에만 노출.
export type StageState = "pending" | "running" | "done" | "canceled";
export type Stage = { key: string; label: string; state: StageState; hint?: string };

// 로그 항목(평평한 시간순). 섹션 개념은 의도적으로 없다: 로그 줄을 도착 시각으로 단계에
// 귀속하면 순서 역전(작성 요약이 완료 신호 뒤 도착) 시 오귀속된다. 단계 표시는 체크리스트 전담.
export type AgentState = "running" | "done" | "canceled";
export type PanelItem =
  // sub-agent 행: id로 시작(스피너)→종료(✓) 제자리 갱신. 결과 없이 끝나면(취소·크래시)
  // ✓가 아니라 "중단됨"(일괄 ✓는 하다 만 작업을 완료로 표시하는 거짓).
  // label은 표시용(중복 시 "회의록 검증 1"처럼 번호), baseLabel은 병렬 형제 매칭 키.
  | { type: "agent"; id: string; baseLabel: string; label: string; state: AgentState }
  | { type: "text"; text: string };

const MAX_ITEMS = 200;

// 표시 상한: 오래된 항목부터 버린다(원문은 headless.jsonl·pipeline.log에 남아 손실 아님).
export function capItems(items: PanelItem[]): PanelItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}
