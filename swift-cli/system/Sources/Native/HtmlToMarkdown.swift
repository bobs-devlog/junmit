// Google Calendar의 description은 단순한 HTML(<br>, <a>, <b>, <i>, <ul>, <li>, <p> 등)을 사용한다.
// 외부 의존성 없이 정규식 + 단순 치환으로 Markdown 변환.
import Foundation

func htmlToMarkdown(_ html: String) -> String {
    if html.isEmpty { return "" }

    var s = html

    // Google Calendar가 description에 자동 삽입하는 "수정 금지" 블록 제거.
    // Meet 링크·전화번호·도움말 링크 등 회의록에는 무가치한 boilerplate이고,
    // Google 본문에 "이 섹션을 수정하지 마시기 바랍니다"라고 명시되어 있다.
    //
    // 동일 sentinel을 사용하는 권위 있는 레퍼런스:
    //  - Apple iOS CalendarFoundation.framework `CalGoogleConferenceFormat`
    //    (sentinel을 고정 문자열로 정의, regex `<sentinel>(.*?)<sentinel>\n?`)
    //  - aaronpk/Meetable `InboundEmailController` (PHP, 시작 sentinel 위치 기반 cut)
    //
    // Apple은 fixed-length sentinel을 쓰지만, 미래 길이 변형 흡수를 위해 `[~:]+`로 약간 관대하게 매칭.
    let sentinelPattern = "-::~:~::[~:]+::-[\\s\\S]*?-::~:~::[~:]+::-"
    s = s.replacingOccurrences(of: sentinelPattern, with: "", options: [.regularExpression])

    // <br>, <br/>, <br /> → 줄바꿈
    s = s.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])

    // <p>...</p> → 본문\n\n
    s = s.replacingOccurrences(of: "</p\\s*>", with: "\n\n", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<p[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])

    // <div>...</div> → 본문\n
    s = s.replacingOccurrences(of: "</div\\s*>", with: "\n", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<div[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])

    // <a href="X">Y</a> → [Y](X). non-greedy로 중첩 매칭 회피.
    let anchorPattern = "<a\\s+[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a\\s*>"
    if let regex = try? NSRegularExpression(pattern: anchorPattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) {
        let range = NSRange(s.startIndex..., in: s)
        s = regex.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: "[$2]($1)")
    }

    // <b>, <strong> → **
    s = s.replacingOccurrences(of: "<(b|strong)[^>]*>", with: "**", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "</(b|strong)\\s*>", with: "**", options: [.regularExpression, .caseInsensitive])

    // <i>, <em> → *
    s = s.replacingOccurrences(of: "<(i|em)[^>]*>", with: "*", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "</(i|em)\\s*>", with: "*", options: [.regularExpression, .caseInsensitive])

    // <li>...</li> → "- ..."
    s = s.replacingOccurrences(of: "<li[^>]*>", with: "\n- ", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "</li\\s*>", with: "", options: [.regularExpression, .caseInsensitive])

    // <ul>, <ol> 컨테이너 제거 (자식 <li>는 위에서 처리됨)
    s = s.replacingOccurrences(of: "<(ul|ol)[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "</(ul|ol)\\s*>", with: "\n", options: [.regularExpression, .caseInsensitive])

    // 잔여 태그 제거
    s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)

    // HTML entity 디코드. &amp;는 마지막 — 다른 entity의 prefix(&)와 충돌 방지.
    let entities: [(String, String)] = [
        ("&nbsp;", " "),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&apos;", "'"),
        ("&#39;", "'"),
        ("&#34;", "\""),
        ("&amp;", "&"),
    ]
    for (entity, char) in entities {
        s = s.replacingOccurrences(of: entity, with: char)
    }

    // 연속 빈 줄 압축 + 양끝 trim
    s = s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}
