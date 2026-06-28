import Foundation

// MARK: - Mention 처리
//
// @firstName 토큰 → ADF mention 노드 변환.
//
// 정책:
//   - `@` 접두가 명시된 firstName만 mention 처리 — 산문에 등장한 자연어 인물 이름은 @ 없으므로 일반 text 유지 (sentinel 정책 일치)
//   - mention dict에 firstName이 있으면 mention 노드, 없으면 `@firstName` plain text 유지
//   - firstName 매칭은 case-insensitive (mention-cache의 normalize와 일관)

enum Mention {
    /// firstName으로 mention 노드 생성. dict 매칭 실패 시 nil.
    static func resolveNode(firstName: String, dict: [String: MentionInfo]) -> [String: Any]? {
        let key = firstName.lowercased()
        guard let info = dict[key] else { return nil }
        return [
            "type": "mention",
            "attrs": [
                "id": info.accountId,
                "text": "@\(info.displayName)",
            ],
        ]
    }

    /// 텍스트에서 `@<firstName>` 패턴 추출. (range, firstName 토큰) 리스트.
    /// firstName은 영문 시작 + 영숫자 (회사 표준).
    static func findMentions(in text: String) -> [(Range<String.Index>, String)] {
        let pattern = #"@([A-Za-z][A-Za-z0-9]*)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = regex.matches(in: text, range: nsRange)
        var results: [(Range<String.Index>, String)] = []
        for m in matches {
            if let r = Range(m.range, in: text),
                let nameR = Range(m.range(at: 1), in: text)
            {
                results.append((r, String(text[nameR])))
            }
        }
        return results
    }

    /// inline text를 받아 mention 처리된 inline ADF 노드 배열로 변환.
    /// `@Bobs`가 dict에 있으면 mention 노드, 없으면 plain text 유지.
    /// 텍스트의 마크(strong, em 등)는 호출자가 별도 처리 — 이 함수는 raw text만.
    static func inlineWithMentions(_ text: String, dict: [String: MentionInfo]) -> [[String: Any]] {
        let mentions = findMentions(in: text)
        if mentions.isEmpty {
            return text.isEmpty ? [] : [["type": "text", "text": text]]
        }

        var result: [[String: Any]] = []
        var cursor = text.startIndex

        for (range, firstName) in mentions {
            // mention 앞 text
            if cursor < range.lowerBound {
                let prefix = String(text[cursor ..< range.lowerBound])
                if !prefix.isEmpty {
                    result.append(["type": "text", "text": prefix])
                }
            }
            // mention 노드 또는 plain `@firstName`
            if let node = resolveNode(firstName: firstName, dict: dict) {
                result.append(node)
            } else {
                result.append(["type": "text", "text": String(text[range])])
            }
            cursor = range.upperBound
        }

        // 마지막 mention 뒤 text
        if cursor < text.endIndex {
            let suffix = String(text[cursor...])
            if !suffix.isEmpty {
                result.append(["type": "text", "text": suffix])
            }
        }

        return result
    }
}
