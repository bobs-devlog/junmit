// 진행 패널 셸·컨테이너 공유 데이터 모델. 컴포넌트 파일에 함수 export를 섞으면 fast refresh가
// 깨져 별도 모듈로 둔다.

export type AgentState = "running" | "done" | "canceled";

export type SubTask = { id: string; label: string; state: AgentState };

// 단계는 앱 상태·파이프라인 마커 기반 결정론(모델 출력 추론 금지: 누락·순서 역전마다 보정이 늘어난다).
export type StageState = "pending" | "running" | "done" | "canceled";
export type Stage = {
  key: string;
  label: string;
  state: StageState;
  // 진행 세부("구간 1/3 요약 중") — 단계 행 아래.
  detail?: string;
  // 그동안 할 수 있는 일("전사본 탭에서 화자 이름을…") — 단계에 매인 정보가 아니라 카드 하단.
  hint?: string;
  // 진행 중 단계에만 — 끝난 단계까지 남기면 카드가 실행 내내 길어진다.
  subtasks?: SubTask[];
};

// 로그 한 줄(평평한 시간순). 섹션 개념은 의도적으로 없다: 로그 줄을 도착 시각으로 단계에
// 귀속하면 순서 역전(작성 요약이 완료 신호 뒤 도착) 시 오귀속된다. 단계 표시는 체크리스트 전담.
export type LogLine = { type: "text"; text: string };

// 로그 줄과 **한 배열에 섞지 말 것**: ① capLines가 진행 중인 sub-agent를 밀어내 카드에서 행이
// 사라지고 ② 로그로 넘길 때 매번 filter로 새 배열이 생겨 셸의 하단 고정 스크롤이 초당 재발화한다.
// label은 표시용(형제 충돌 시 "회의록 검증 1"처럼 번호), baseLabel은 형제 매칭 키.
export type AgentRow = {
  id: string;
  baseLabel: string;
  label: string;
  state: AgentState;
  stageKey: string;
};

const MAX_LINES = 200;

// 오래된 줄부터 버린다(원문은 headless.jsonl·pipeline.log에 남아 손실 아님).
export function capLines(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
}
