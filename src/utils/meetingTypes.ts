// 회의 유형 가이드(.md) 파싱 헬퍼.
//
// 유형 가이드는 `## 예시 회의록` 섹션 안에 ```markdown 코드펜스로 "이 유형이 만들어내는
// 회의록 샘플"을 담는다. 관리 화면은 추상적인 가이드 원문 대신 이 예시를 전면에 보여줘
// 사용자가 결과물을 한눈에 판단하게 한다. (few-shot 앵커로 /meeting 품질도 올라감)

/**
 * 가이드 원문에서 `## …예시…` 헤딩 뒤 첫 코드펜스(```…```) 내용을 추출한다.
 * 예시 샘플 자체가 `## 결정` 같은 내부 헤딩을 포함하므로, 헤딩 경계가 아니라
 * 코드펜스로 구획해 안전하게 잘라낸다. 펜스가 없으면 null.
 */
export function extractExampleSection(raw: string): string | null {
  const lines = raw.split("\n");

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && lines[i].includes("예시")) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;

  let fenceStart = -1;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (/^\s*```/.test(lines[j])) {
      fenceStart = j;
      break;
    }
    // 다음 섹션 헤딩을 먼저 만나면 이 섹션엔 펜스가 없는 것.
    if (/^##\s+/.test(lines[j])) return null;
  }
  if (fenceStart === -1) return null;

  let fenceEnd = -1;
  for (let j = fenceStart + 1; j < lines.length; j++) {
    if (/^\s*```/.test(lines[j])) {
      fenceEnd = j;
      break;
    }
  }
  if (fenceEnd === -1) return null;

  const body = lines
    .slice(fenceStart + 1, fenceEnd)
    .join("\n")
    .trim();
  return body || null;
}
