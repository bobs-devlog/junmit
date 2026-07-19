// 숫자 표기 유틸 — 로캘(ko-KR) 결정의 단일 지점. toLocaleString 직접 호출 대신 이쪽을 쓴다.

// 천 단위 콤마 (6773 → "6,773").
export function formatNumber(value: number): string {
  return value.toLocaleString("ko-KR");
}

// 텍스트 속 4자리 이상 정수에 콤마 — 숫자 열 일괄 치환이라 날짜·ID가 든 텍스트엔 오변환.
// 형식을 통제하는 라인(설치 진행 등) 전용.
export function formatNumbersInText(text: string): string {
  return text.replace(/\d{4,}/g, (digits) => formatNumber(Number(digits)));
}
