import Foundation

// MARK: - 회의록 sentinel 매핑
//
// 회의록 작성 가이드 (notes-rules.md)의 sentinel을 ADF panel 노드로 매핑.
// 단일 출처 — publish 스킬에 매핑 규칙 중복 명시하지 않음.
//
// 매핑 정책:
//   ⚡ 결정사항          → panel: info  (긍정 강조)
//   → 향후 방향          → panel: note  (참고 정보)
//   > ⚠️ 품질 경고       → panel: warning (주의)
//
// 적용 위치:
//   - paragraph 텍스트 시작 부분이 sentinel과 매칭되면 paragraph → panel로 변환
//   - blockquote의 첫 paragraph가 sentinel과 매칭되면 blockquote → panel로 변환

enum SentinelMatch {
    case info(stripped: String)       // ⚡ 결정사항
    case note(stripped: String)       // → 향후 방향
    case warning(stripped: String)    // > ⚠️ 품질 경고
    case none
}

enum Sentinel {
    /// paragraph 텍스트 시작 부분에서 sentinel 매칭. 매칭 시 panelType + 접두 제거된 텍스트.
    static func detect(in text: String) -> SentinelMatch {
        let trimmed = text.trimmingCharacters(in: .whitespaces)

        // ⚡ 결정사항 — info panel
        if trimmed.hasPrefix("⚡ ") {
            return .info(stripped: String(trimmed.dropFirst(2)))
        }
        if trimmed.hasPrefix("⚡") {
            return .info(stripped: String(trimmed.dropFirst(1)).trimmingCharacters(in: .whitespaces))
        }

        // → 향후 방향 — note panel (화살표 → 또는 일반 -> 둘 다 허용)
        if trimmed.hasPrefix("→ ") || trimmed.hasPrefix("-> ") {
            let prefixLen = trimmed.hasPrefix("→ ") ? 2 : 3
            return .note(stripped: String(trimmed.dropFirst(prefixLen)))
        }

        // ⚠️ — warning panel (blockquote 내부에서도 사용)
        if trimmed.hasPrefix("⚠️ ") {
            return .warning(stripped: String(trimmed.dropFirst(2)))
        }
        if trimmed.hasPrefix("⚠️") {
            return .warning(stripped: String(trimmed.dropFirst(1)).trimmingCharacters(in: .whitespaces))
        }

        return .none
    }

    /// SentinelMatch를 ADF panelType 문자열로.
    static func panelType(_ match: SentinelMatch) -> String? {
        switch match {
        case .info: return "info"
        case .note: return "note"
        case .warning: return "warning"
        case .none: return nil
        }
    }

    /// SentinelMatch에서 sentinel 접두를 제거한 텍스트.
    static func strippedText(_ match: SentinelMatch) -> String? {
        switch match {
        case .info(let s), .note(let s), .warning(let s): return s
        case .none: return nil
        }
    }
}
