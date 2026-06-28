import Foundation
import Markdown

// MARK: - markdown AST → ADF JSON 변환
//
// swift-markdown(Apple 공식 CommonMark 파서)로 파싱한 AST를 ADF doc으로 변환.
// 회의록 특화 처리:
//   - paragraph/blockquote의 sentinel 매핑 → panel
//   - taskItem.content는 inline text 직접 (paragraph wrapper 금지)
//   - taskList/taskItem localId 자동 부여
//   - @firstName mention 노드 자동 삽입 (Mention.inlineWithMentions)
//
// 회의 제목(meeting.json.title)은 createConfluencePage의 title 인자로 별도 전달되므로
// 본문에는 H1을 작성하지 않는 정책 (가이드에서 강제). 사용자가 본문에 H1을 박은 경우 그대로 변환.
//
// ADF spec 기준 (https://developer.atlassian.com/cloud/jira/platform/apis/document/):
//   doc: { version: 1, type: "doc", content: [...] }
//   inline 노드는 marks 배열로 강조 표현 (strong, em, code, link 등)
//   block 노드는 content에 child 배열

struct AdfBuilder {
    let mentionDict: [String: MentionInfo]

    private var taskListCounter = 0
    private var taskItemCounter = 0

    init(mentionDict: [String: MentionInfo]) {
        self.mentionDict = mentionDict
    }

    // MARK: - 진입점

    mutating func build(_ document: Document) -> [String: Any] {
        var content: [[String: Any]] = []
        for block in document.blockChildren {
            if let node = convertBlock(block) {
                content.append(node)
            }
        }

        return [
            "version": 1,
            "type": "doc",
            "content": content,
        ]
    }

    // MARK: - block 변환

    /// `inListItem`: 리스트 항목 내부 문단이면 sentinel(⚡/→/⚠️) 매칭을 끈다.
    /// 결론 태그(향후 방향·결정·품질 경고)는 가이드상 항상 최상위 블록 문단/blockquote에만 등장하고,
    /// 리스트 안의 `→`는 Q&A 응답(`- **→ 이름**: 답변`)이라 패널이 되면 안 된다 (panel은 ADF에서 doc 직계만 허용).
    private mutating func convertBlock(_ block: Markup, inListItem: Bool = false) -> [String: Any]? {
        switch block {
        case let heading as Heading:
            return convertHeading(heading)
        case let paragraph as Paragraph:
            return convertParagraph(paragraph, allowSentinel: !inListItem)
        case let list as UnorderedList:
            return convertUnorderedList(list)
        case let list as OrderedList:
            return convertOrderedList(list)
        case let blockquote as BlockQuote:
            return convertBlockQuote(blockquote, allowSentinel: !inListItem)
        case let codeBlock as CodeBlock:
            return convertCodeBlock(codeBlock)
        case let table as Table:
            return convertTable(table)
        case is ThematicBreak:
            return ["type": "rule"]
        default:
            // 알 수 없는 block은 plain paragraph로 fallback (raw markdown 출력)
            return ["type": "paragraph", "content": [["type": "text", "text": block.format()]]]
        }
    }

    private mutating func convertHeading(_ heading: Heading) -> [String: Any] {
        return [
            "type": "heading",
            "attrs": ["level": heading.level],
            "content": convertInlines(Array(heading.inlineChildren)),
        ]
    }

    /// paragraph — sentinel 매칭 시 panel로 변환, 아니면 일반 paragraph.
    /// `allowSentinel`이 false면(리스트 항목 내부) sentinel 검사를 건너뛰고 항상 일반 paragraph.
    private mutating func convertParagraph(_ paragraph: Paragraph, allowSentinel: Bool = true) -> [String: Any] {
        let inlines = Array(paragraph.inlineChildren)
        let plainText = inlineToPlainText(inlines)
        let match = allowSentinel ? Sentinel.detect(in: plainText) : .none

        if let panelType = Sentinel.panelType(match), let stripped = Sentinel.strippedText(match) {
            // sentinel 접두 제거 후 그 안의 inline 처리 (mention 등은 살림)
            return [
                "type": "panel",
                "attrs": ["panelType": panelType],
                "content": [[
                    "type": "paragraph",
                    "content": Mention.inlineWithMentions(stripped, dict: mentionDict),
                ]],
            ]
        }

        return [
            "type": "paragraph",
            "content": convertInlines(inlines),
        ]
    }

    private mutating func convertUnorderedList(_ list: UnorderedList) -> [String: Any] {
        // task list 검출: 모든 항목이 - [ ] / - [x] 형태이면 taskList로 변환.
        let items = Array(list.listItems)
        let isTaskList = items.allSatisfy { $0.checkbox != nil }
        if isTaskList && !items.isEmpty {
            return convertTaskList(items)
        }
        var content: [[String: Any]] = []
        for item in items {
            content.append(convertListItem(item))
        }
        return [
            "type": "bulletList",
            "content": content,
        ]
    }

    private mutating func convertOrderedList(_ list: OrderedList) -> [String: Any] {
        var content: [[String: Any]] = []
        for item in list.listItems {
            content.append(convertListItem(item))
        }
        return [
            "type": "orderedList",
            "content": content,
        ]
    }

    private mutating func convertListItem(_ item: ListItem) -> [String: Any] {
        var content: [[String: Any]] = []
        for child in item.blockChildren {
            // inListItem: true — 리스트 내부 문단의 `→`/`⚡` Q&A 응답이 패널로 변환되지 않게.
            // 중첩 리스트는 convertUnorderedList → convertListItem 재진입 시 다시 true가 되어 전 depth에 전파됨.
            if let node = convertBlock(child, inListItem: true) {
                content.append(node)
            }
        }
        return [
            "type": "listItem",
            "content": content,
        ]
    }

    /// taskList — list items가 모두 checkbox일 때. taskItem.content는 inline text 직접 (paragraph wrapper 금지).
    private mutating func convertTaskList(_ items: [ListItem]) -> [String: Any] {
        taskListCounter += 1
        let listLocalId = "tasks-\(taskListCounter)"

        var taskItems: [[String: Any]] = []
        for item in items {
            taskItemCounter += 1
            let state = (item.checkbox == .checked) ? "DONE" : "TODO"
            // taskItem의 첫 paragraph inline을 가져옴 — paragraph wrapper 제거.
            var inlineContent: [[String: Any]] = []
            if let firstParagraph = item.blockChildren.first(where: { $0 is Paragraph }) as? Paragraph {
                inlineContent = convertInlines(Array(firstParagraph.inlineChildren))
            }
            taskItems.append([
                "type": "taskItem",
                "attrs": [
                    "state": state,
                    "localId": "task-\(taskItemCounter)",
                ],
                "content": inlineContent,
            ])
        }

        return [
            "type": "taskList",
            "attrs": ["localId": listLocalId],
            "content": taskItems,
        ]
    }

    /// blockquote — 첫 paragraph가 sentinel이면 panel로 변환, 아니면 일반 blockquote.
    /// `allowSentinel`이 false면(리스트 항목 내부) sentinel을 끈다 — panel은 ADF에서 doc 직계만 허용.
    private mutating func convertBlockQuote(_ blockquote: BlockQuote, allowSentinel: Bool = true) -> [String: Any] {
        // 첫 paragraph가 sentinel 매칭 시 panel
        let blocks = Array(blockquote.blockChildren)
        if allowSentinel, let firstPara = blocks.first as? Paragraph {
            let firstText = inlineToPlainText(Array(firstPara.inlineChildren))
            let match = Sentinel.detect(in: firstText)
            if let panelType = Sentinel.panelType(match), let stripped = Sentinel.strippedText(match) {
                var panelContent: [[String: Any]] = [[
                    "type": "paragraph",
                    "content": Mention.inlineWithMentions(stripped, dict: mentionDict),
                ]]
                // 나머지 paragraph는 그대로 추가
                for b in blocks.dropFirst() {
                    if let node = convertBlock(b) {
                        panelContent.append(node)
                    }
                }
                return [
                    "type": "panel",
                    "attrs": ["panelType": panelType],
                    "content": panelContent,
                ]
            }
        }

        var content: [[String: Any]] = []
        for child in blocks {
            // 리스트 내부(allowSentinel=false)면 자식 문단의 sentinel도 꺼야 panel-in-list가 안 생긴다.
            if let node = convertBlock(child, inListItem: !allowSentinel) {
                content.append(node)
            }
        }
        return [
            "type": "blockquote",
            "content": content,
        ]
    }

    private func convertCodeBlock(_ codeBlock: CodeBlock) -> [String: Any] {
        var node: [String: Any] = [
            "type": "codeBlock",
            "content": [["type": "text", "text": codeBlock.code]],
        ]
        if let lang = codeBlock.language, !lang.isEmpty {
            node["attrs"] = ["language": lang]
        }
        return node
    }

    private mutating func convertTable(_ table: Table) -> [String: Any] {
        var rows: [[String: Any]] = []

        // header row
        let headerRow = table.head
        var headerCells: [[String: Any]] = []
        for cell in headerRow.cells {
            headerCells.append([
                "type": "tableHeader",
                "content": [[
                    "type": "paragraph",
                    "content": convertInlines(Array(cell.inlineChildren)),
                ]],
            ])
        }
        if !headerCells.isEmpty {
            rows.append(["type": "tableRow", "content": headerCells])
        }

        // body rows
        for row in table.body.rows {
            var cells: [[String: Any]] = []
            for cell in row.cells {
                cells.append([
                    "type": "tableCell",
                    "content": [[
                        "type": "paragraph",
                        "content": convertInlines(Array(cell.inlineChildren)),
                    ]],
                ])
            }
            rows.append(["type": "tableRow", "content": cells])
        }

        return [
            "type": "table",
            "content": rows,
        ]
    }

    // MARK: - inline 변환 — mention 포함

    /// inline 노드 배열 → ADF inline 노드 배열. 텍스트는 mention 처리 + 마크 적용.
    private func convertInlines(_ inlines: [InlineMarkup]) -> [[String: Any]] {
        var result: [[String: Any]] = []
        for inline in inlines {
            result.append(contentsOf: convertInline(inline))
        }
        return result
    }

    private func convertInline(_ inline: InlineMarkup) -> [[String: Any]] {
        switch inline {
        case let text as Text:
            // raw text — mention 패턴 처리
            return Mention.inlineWithMentions(text.plainText, dict: mentionDict)

        case let strong as Strong:
            return applyMark(strong.inlineChildren, mark: ["type": "strong"])

        case let emphasis as Emphasis:
            return applyMark(emphasis.inlineChildren, mark: ["type": "em"])

        case let strike as Strikethrough:
            return applyMark(strike.inlineChildren, mark: ["type": "strike"])

        case let code as InlineCode:
            return [[
                "type": "text",
                "text": code.code,
                "marks": [["type": "code"]],
            ]]

        case let link as Markdown.Link:
            let href = link.destination ?? ""
            return applyMark(link.inlineChildren, mark: ["type": "link", "attrs": ["href": href]])

        case is LineBreak:
            return [["type": "hardBreak"]]

        case is SoftBreak:
            // soft break는 공백으로 (markdown 관례)
            return [["type": "text", "text": " "]]

        default:
            return [["type": "text", "text": inline.format()]]
        }
    }

    /// inline 자식들을 처리하고 각 text 노드에 mark를 추가.
    private func applyMark(_ inlines: some Sequence<InlineMarkup>, mark: [String: Any]) -> [[String: Any]] {
        var result: [[String: Any]] = []
        for inline in Array(inlines) {
            let nodes = convertInline(inline)
            for var node in nodes {
                if node["type"] as? String == "text" {
                    var marks = (node["marks"] as? [[String: Any]]) ?? []
                    marks.append(mark)
                    node["marks"] = marks
                }
                result.append(node)
            }
        }
        return result
    }

    /// inline 노드들을 plain text로 — sentinel 매칭 등 prefix 검사용.
    private func inlineToPlainText(_ inlines: [InlineMarkup]) -> String {
        return inlines.map { $0.plainText }.joined()
    }
}
