import Foundation
import ArgumentParser
import Markdown
import Speakers

// MARK: - CLI
//
// publish 스킬용 회의록 markdown → ADF JSON 변환 sidecar.
// LLM은 mention dict + 입력 markdown을 파일로 전달, ADF JSON을 받아 createConfluencePage에 전달.
// 결정론적 텍스트 변환은 모두 이 binary가 처리 — LLM 토큰·일관성 부담 제거.
//
// 사용 예:
//   bin/adf convert \
//     --input notes.md \
//     --mentions mention-map.json \
//     --output adf.json
//
// SPEAKER_XX 자동 치환:
//   --input 파일과 같은 디렉토리의 speaker_mapping.json을 자동 검색해 변환 직전 치환.
//   매핑 파일이 없으면 skip (SPEAKER 라벨 그대로 유지). publish 흐름은 sessionDir에 mapping 존재.
//
// 회의록 특화 처리:
//   1. taskList/taskItem localId 자동 부여
//   2. taskItem.content는 inline text 직접 (paragraph wrapper 금지)
//   3. sentinel 매핑: ⚡결정 → panel:info, →향후 방향 → panel:note, > ⚠️ → panel:warning
//   4. mention 처리: taskItem·참석자 섹션의 @firstName → mention 노드, 산문은 일반 text 유지
//
// 본문에는 첫 H1 (회의 제목)을 작성하지 않는 정책 — 회의 제목은 meeting.json.title 단일 진실 원천에서
// createConfluencePage의 title 인자로 전달. 만약 본문에 H1이 있으면 그대로 ADF에 들어가 페이지 본문 H1으로 표시됨.

@main
struct Adf: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "adf",
        abstract: "회의록 markdown → ADF JSON 변환 (publish 스킬용)",
        subcommands: [Convert.self]
    )
}

struct Convert: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "convert",
        abstract: "SPEAKER 치환된 markdown → 회의록 특화 ADF JSON"
    )

    @Option(name: .long, help: "입력 markdown 파일 경로 (SPEAKER_XX 치환 완료 상태)")
    var input: String

    @Option(name: .long, help: "mention dict JSON 파일 경로 — {firstName: {accountId, displayName}}. 없으면 mention 미적용")
    var mentions: String?

    @Option(name: .long, help: "ADF JSON 출력 파일 경로 (생략 시 stdout)")
    var output: String?

    mutating func run() throws {
        let rawMd = try String(contentsOf: URL(fileURLWithPath: input), encoding: .utf8)
        let mentionDict = try loadMentions(path: mentions)

        // input 파일 디렉토리에서 speaker_mapping.json 자동 검색·적용.
        // publish 흐름의 sessionDir은 항상 같은 디렉토리에 mapping 존재. mapping 없으면 SPEAKER 그대로.
        let speakerMap = try SpeakerMap.autoLoad(fromInputPath: input)
        let md = speakerMap.substitute(rawMd)

        let document = Document(parsing: md)
        var builder = AdfBuilder(mentionDict: mentionDict)
        let adf = builder.build(document)

        // ASCII escape — Atlassian MCP wrapper의 UTF-8 byte truncate 회피.
        // wrapper가 body 문자열을 byte 단위로 자른 후 char-index로 parse 시 한국어 multi-byte가
        // 중간에서 잘려 "Expected ',' or ']' after array element" 에러 발생. 비-ASCII를 \uXXXX로
        // escape하면 byte = char 1:1이라 같은 truncate 시점에서도 escape sequence 단위로 잘림.
        // JSON spec 표준 (\uXXXX) — 수신 측 parser 호환.
        let data = try JSONSerialization.data(
            withJSONObject: adf,
            options: [.sortedKeys]
        )
        let utf8String = String(data: data, encoding: .utf8) ?? "{}"
        let escapedString = asciiEscape(utf8String)
        let escapedData = Data(escapedString.utf8)

        if let outputPath = output {
            try escapedData.write(to: URL(fileURLWithPath: outputPath))
        } else {
            FileHandle.standardOutput.write(escapedData)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
    }

    /// 비-ASCII 문자를 JSON \uXXXX 형식으로 escape. BMP 외 문자(>0xFFFF)는 surrogate pair.
    private func asciiEscape(_ s: String) -> String {
        var result = ""
        result.reserveCapacity(s.count * 2)
        for scalar in s.unicodeScalars {
            if scalar.value < 0x80 {
                result.append(Character(scalar))
            } else if scalar.value <= 0xFFFF {
                result += String(format: "\\u%04x", scalar.value)
            } else {
                // surrogate pair
                let v = scalar.value - 0x10000
                let high = 0xD800 + (v >> 10)
                let low = 0xDC00 + (v & 0x3FF)
                result += String(format: "\\u%04x\\u%04x", high, low)
            }
        }
        return result
    }

    private func loadMentions(path: String?) throws -> [String: MentionInfo] {
        guard let path = path else { return [:] }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try JSONDecoder().decode([String: MentionInfo].self, from: data)
    }
}

// MARK: - Mention dict 구조

struct MentionInfo: Codable {
    let accountId: String
    let displayName: String
}
