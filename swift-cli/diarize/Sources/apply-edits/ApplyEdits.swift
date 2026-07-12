import Foundation
import ArgumentParser

// MARK: - CLI
//
// LLM(/meeting 스킬)이 작성한 transcript 교정을 transcript_corrected.txt에
// in-place로 적용하는 sidecar.
//
// 두 종류의 교정을 명시적 mode로 분리 처리:
//   --kind text    : transcript_text_edits.json (LLM 텍스트 교정 명세)
//   --kind speaker : transcript_speaker_edits.json (LLM 화자 라벨 재할당 명세)
//
// 한 호출당 한 종류만 처리하므로 멱등성 분기 불필요. 매칭 실패 항목은
// JSON에서 자동 제외 → UI 매칭 정확성 보장.
//
// SKILL.md 흐름 (1단계 sub-agent 종료 후, apply-corrections.sh 경유):
//   apply-edits <session> --kind speaker  (화자 라벨 재할당 — 항상)
//   apply-edits <session> --kind text     (텍스트 교정 — 전사본 교정 ON일 때만, "full" 인자)
//
// 라인 수는 변하지 않음 — 텍스트는 라인 내부 first-occurrence 치환,
// 라벨은 라인 시작 prefix 치환만 수행.

enum EditKind: String, ExpressibleByArgument {
    case text
    case speaker
}

struct TextEdit: Codable {
    var line: Int
    var time: String?
    var old: String
    var new: String
    var reason: String?
    var estimated: Bool?
}

struct TextEditsFile: Codable {
    var edits: [TextEdit]
}

struct SpeakerEdit: Codable {
    var line: Int
    var time: String?
    var text: String?
    var originalLabel: String
    var newLabel: String
    var reason: String?

    enum CodingKeys: String, CodingKey {
        case line
        case time
        case text
        case originalLabel = "original_label"
        case newLabel = "new_label"
        case reason
    }
}

struct SpeakerEditsFile: Codable {
    var edits: [SpeakerEdit]
}

@main
struct ApplyEdits: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "apply-edits",
        abstract: "transcript 교정을 transcript_corrected.txt에 적용 (--kind text | speaker)"
    )

    @Argument(help: "세션 디렉토리 경로")
    var sessionDir: String

    @Option(name: .long, help: "적용할 교정 종류 (text | speaker)")
    var kind: EditKind

    func run() throws {
        let session = URL(fileURLWithPath: sessionDir)
        let targetURL = session.appendingPathComponent("transcript_corrected.txt")

        let content = try String(contentsOf: targetURL, encoding: .utf8)
        var lines = content.components(separatedBy: "\n")

        let summary: String
        switch kind {
        case .text:
            let editsURL = session.appendingPathComponent("transcript_text_edits.json")
            let (applied, total) = try applyTextEdits(url: editsURL, lines: &lines)
            summary = "\(applied)/\(total) text"
        case .speaker:
            let editsURL = session.appendingPathComponent("transcript_speaker_edits.json")
            let (applied, total) = try applySpeakerEdits(url: editsURL, lines: &lines)
            summary = "\(applied)/\(total) speaker"
        }

        // 비원자적 쓰기 — Claude 샌드박스(Seatbelt)가 원자적 쓰기의 임시파일+rename을 거부해 승인
        // 프롬프트로 빠지던 것을 회피(직접 쓰기는 cp처럼 통과). 재실행 가능한 출력이라 원자성 손실 허용.
        try lines.joined(separator: "\n").write(to: targetURL, atomically: false, encoding: .utf8)
        print("Applied \(summary) corrections")
    }

    private func applyTextEdits(url: URL, lines: inout [String]) throws -> (applied: Int, total: Int) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return (0, 0)
        }
        let data = try Data(contentsOf: url)
        let file = try JSONDecoder().decode(TextEditsFile.self, from: data)

        var applied: [TextEdit] = []
        for var edit in file.edits {
            let idx = edit.line - 1
            guard idx >= 0, idx < lines.count else {
                logSkip("text", line: edit.line, reason: "line out of range (file has \(lines.count) lines)")
                continue
            }
            guard let range = lines[idx].range(of: edit.old) else {
                logSkip("text", line: edit.line, reason: "old not found: \"\(truncate(edit.old))\"")
                continue
            }
            if edit.time == nil {
                edit.time = headerTime(of: lines[idx])
            }
            lines[idx].replaceSubrange(range, with: edit.new)
            applied.append(edit)
        }

        // 재실행 가드: 이미 적용된 뒤 다시 호출되면 old가 전부 사라져 0건 적용이 된다.
        // 이때 JSON을 재작성하면 이전 실행이 기록한 유효한 교정 마커가 통째로 지워지므로 보존.
        // (진짜 전건 실패 배치를 남겨도 UI는 new-포함 검증으로 조용히 스킵해 무해)
        if applied.isEmpty && !file.edits.isEmpty {
            logSkip("text", line: 0, reason: "0/\(file.edits.count) applied — 기존 JSON 보존 (재실행 추정)")
            return (0, file.edits.count)
        }
        try writeJSON(TextEditsFile(edits: applied), to: url)
        return (applied.count, file.edits.count)
    }

    /// 라인 헤더 `[SPEAKER_XX M:SS]`에서 시각 토큰을 추출 (UI fallback 매칭용 time 주입).
    /// LLM이 time을 방출하지 않아도 UI의 라인 시프트 fallback 매칭이 유지되도록 적용 시점에 채운다.
    private func headerTime(of line: String) -> String? {
        guard line.hasPrefix("["), let close = line.firstIndex(of: "]") else { return nil }
        let header = line[line.index(after: line.startIndex)..<close]
        guard let space = header.lastIndex(of: " ") else { return nil }
        let time = header[header.index(after: space)...]
        return time.contains(":") ? String(time) : nil
    }

    private func applySpeakerEdits(url: URL, lines: inout [String]) throws -> (applied: Int, total: Int) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return (0, 0)
        }
        let data = try Data(contentsOf: url)
        let file = try JSONDecoder().decode(SpeakerEditsFile.self, from: data)

        var applied: [SpeakerEdit] = []
        for edit in file.edits {
            let idx = edit.line - 1
            guard idx >= 0, idx < lines.count else {
                logSkip("speaker", line: edit.line, reason: "line out of range (file has \(lines.count) lines)")
                continue
            }
            let oldPrefix = "[\(edit.originalLabel) "
            guard lines[idx].hasPrefix(oldPrefix) else {
                logSkip("speaker", line: edit.line, reason: "label mismatch (expected \(edit.originalLabel), got \"\(truncate(lines[idx]))\")")
                continue
            }
            let newPrefix = "[\(edit.newLabel) "
            lines[idx] = newPrefix + String(lines[idx].dropFirst(oldPrefix.count))
            applied.append(edit)
        }

        // 재실행 가드 (text와 동일): 라벨이 이미 재할당된 파일에 다시 돌면 전건 mismatch로
        // 0건 적용이 되는데, 이때 JSON을 재작성하면 유효한 교정 마커가 통째로 지워진다.
        if applied.isEmpty && !file.edits.isEmpty {
            logSkip("speaker", line: 0, reason: "0/\(file.edits.count) applied — 기존 JSON 보존 (재실행 추정)")
            return (0, file.edits.count)
        }
        try writeJSON(SpeakerEditsFile(edits: applied), to: url)
        return (applied.count, file.edits.count)
    }

    private func logSkip(_ kind: String, line: Int, reason: String) {
        FileHandle.standardError.write(Data("[\(kind)] skip line \(line): \(reason)\n".utf8))
    }

    private func truncate(_ s: String, max: Int = 40) -> String {
        s.count <= max ? s : String(s.prefix(max)) + "..."
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        // 비원자적 쓰기 — 위 corrected.txt 쓰기와 동일 이유(샌드박스가 원자적 쓰기의 임시파일+rename 거부).
        try data.write(to: url)
    }
}
