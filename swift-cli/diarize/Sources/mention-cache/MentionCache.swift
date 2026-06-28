import Foundation
import ArgumentParser
import Speakers

// MARK: - CLI
//
// publish 스킬용 Atlassian mention 매핑 캐시 sidecar.
// firstName → { accountId, displayName } 단순 dict를 user 데이터 영역에
// JSON으로 보관. LLM은 mention-map.json 직접 접근 X — 이 binary로만.
//
// 모든 입력은 first token + lowercase로 normalize:
//   "Bobs"      → "bobs"
//   "BOBS"      → "bobs"
//   "Bobs Kim"  → "bobs"  (회사 표준상 first name 유일 가정)
//
// 명령:
//   get <name>                  → stdout: accountId, exit 0 (hit) / exit 1 (miss)
//   get <name> --json           → stdout: entry JSON 전체
//   set <name> <accountId> <displayName>
//   list                        → stdout: 전체 cache JSON
//   build-dict <name>...        → stdout: 매칭된 entry만 모은 lowercase-keyed JSON
//                                 publish 스킬용. 캐시 hit만 포함, miss는 자동 제외.
//                                 모두 miss면 빈 객체 `{}` 출력 (exit 0)
//
// 저장 위치: ~/Library/Application Support/app.junmit/mention-map.json
// 쓰기는 atomic — temp file → replace 패턴으로 partial write 보호.

// MARK: - 위치

let cachePath: URL = {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home
        .appendingPathComponent("Library")
        .appendingPathComponent("Application Support")
        .appendingPathComponent("app.junmit")
        .appendingPathComponent("mention-map.json")
}()

// MARK: - Schema

struct MentionEntry: Codable {
    var accountId: String
    var displayName: String
}

typealias MentionMap = [String: MentionEntry]

// MARK: - Helpers

/// 입력을 cache key로 변환 — 첫 토큰 추출 후 lowercase.
/// 사용자가 "Bobs", "bobs", "BOBS", "Bobs Kim" 모두 같은 key("bobs")에 매핑.
func normalize(_ input: String) -> String {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstToken = trimmed.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
    return firstToken.lowercased()
}

func loadCache() -> MentionMap {
    guard let data = try? Data(contentsOf: cachePath) else { return [:] }
    return (try? JSONDecoder().decode(MentionMap.self, from: data)) ?? [:]
}

func saveCache(_ map: MentionMap) throws {
    let parent = cachePath.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(map)

    // atomic write — temp 파일에 쓴 후 replaceItemAt으로 원자적 교체.
    let temp = cachePath.appendingPathExtension("tmp")
    try data.write(to: temp)

    if FileManager.default.fileExists(atPath: cachePath.path) {
        _ = try FileManager.default.replaceItemAt(cachePath, withItemAt: temp)
    } else {
        try FileManager.default.moveItem(at: temp, to: cachePath)
    }
}

// MARK: - Commands

@main
struct MentionCache: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mention-cache",
        abstract: "Atlassian mention 매핑 캐시 sidecar (publish 스킬용)",
        subcommands: [GetCmd.self, SetCmd.self, ListCmd.self, BuildDictCmd.self, ExtractCandidatesCmd.self, ResolveCmd.self]
    )
}

struct GetCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "get",
        abstract: "이름으로 cache 조회. miss 시 exit 1 + 출력 없음."
    )

    @Argument(help: "참석자 이름 (대소문자·fullName 모두 허용 — sidecar가 normalize)")
    var name: String

    @Flag(name: .long, help: "entry JSON 전체 출력 (accountId + displayName)")
    var json: Bool = false

    mutating func run() throws {
        let cache = loadCache()
        let key = normalize(name)
        guard let entry = cache[key] else {
            throw ExitCode.failure
        }
        if json {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted]
            let data = try encoder.encode(entry)
            print(String(data: data, encoding: .utf8) ?? "")
        } else {
            print(entry.accountId)
        }
    }
}

struct SetCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "set",
        abstract: "이름·accountId·displayName 저장 (atomic write)"
    )

    @Argument(help: "참석자 이름 (회의록 표기 그대로 — sidecar가 normalize)")
    var name: String

    @Argument(help: "Atlassian accountId (예: 712020:...)")
    var accountId: String

    @Argument(help: "displayName (예: Bobs Kim)")
    var displayName: String

    mutating func run() throws {
        let key = normalize(name)
        guard !key.isEmpty else {
            FileHandle.standardError.write(Data("normalize 결과가 빈 키 — name 입력 확인 필요\n".utf8))
            throw ExitCode(2)
        }
        var cache = loadCache()
        cache[key] = MentionEntry(accountId: accountId, displayName: displayName)
        try saveCache(cache)
    }
}

struct ListCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list",
        abstract: "전체 cache JSON 출력 (디버그용)"
    )

    mutating func run() throws {
        let cache = loadCache()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(cache)
        print(String(data: data, encoding: .utf8) ?? "{}")
    }
}

/// 회의록(markdown)에서 mention 후보 firstName 추출 — extract-candidates·resolve 공유 helper.
///
/// 동작:
/// 1. markdown read
/// 2. SpeakerMap.substitute로 SPEAKER_XX → 표시 라벨(이름 또는 "참석자 N") 치환 (adf와 동일)
///    — 미매핑의 "참석자 N"은 한글이라 3단계 `@firstName`(영문 시작) 정규식에 안 걸려 mention 후보가 안 됨
/// 3. `@firstName` 정규식 매칭 (Mention.swift와 동일 정책: 영문 시작 + 영숫자)
/// 4. SPEAKER_ prefix 잔재 제외 + case-insensitive dedup (첫 등장 케이스 보존)
func extractMentionCandidates(input: String, speakerMappingPath: String?) throws -> [String] {
    let markdown = try String(contentsOfFile: input, encoding: .utf8)

    let speakerMap: SpeakerMap
    if let mappingPath = speakerMappingPath {
        speakerMap = (try? SpeakerMap(jsonPath: mappingPath)) ?? SpeakerMap()
    } else {
        speakerMap = (try? SpeakerMap.autoLoad(fromInputPath: input)) ?? SpeakerMap()
    }
    let substituted = speakerMap.substitute(markdown)

    let pattern = #"@([A-Za-z][A-Za-z0-9]*)"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let nsRange = NSRange(substituted.startIndex..., in: substituted)
    let matches = regex.matches(in: substituted, range: nsRange)

    var seen: Set<String> = []
    var ordered: [String] = []
    for m in matches {
        guard let r = Range(m.range(at: 1), in: substituted) else { continue }
        let name = String(substituted[r])
        let key = name.lowercased()
        if key.hasPrefix("speaker_") { continue }
        if !seen.contains(key) {
            seen.insert(key)
            ordered.append(name)
        }
    }
    return ordered
}

struct ExtractCandidatesCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "extract-candidates",
        abstract: "회의록(meeting-notes.md)에서 mention 후보 firstName 추출. publish 스킬이 build-dict 입력으로 사용."
    )

    @Option(name: .long, help: "회의록 markdown 파일 경로 (보통 {SESSION_DIR}/meeting-notes.md)")
    var input: String

    @Option(name: .long, help: "speaker_mapping.json 경로 (생략 시 input과 같은 디렉토리에서 자동 검색)")
    var speakerMapping: String?

    mutating func run() throws {
        let candidates: [String]
        do {
            candidates = try extractMentionCandidates(input: input, speakerMappingPath: speakerMapping)
        } catch {
            FileHandle.standardError.write(Data("입력 파일 읽기 실패 (\(input)): \(error)\n".utf8))
            throw ExitCode(2)
        }
        for name in candidates {
            print(name)
        }
    }
}

struct ResolveCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "resolve",
        abstract: "extract-candidates + 각 firstName cache 조회 일괄 처리. publish 스킬이 LLM의 sequential Bash 호출(N+2회)을 1회로 줄이는 용도."
    )

    @Option(name: .long, help: "회의록 markdown 파일 경로 (보통 {SESSION_DIR}/meeting-notes.md)")
    var input: String

    @Option(name: .long, help: "speaker_mapping.json 경로 (생략 시 input과 같은 디렉토리에서 자동 검색)")
    var speakerMapping: String?

    /// 출력 JSON 스키마 — publish 스킬이 misses에 대해서만 Atlassian lookup 호출.
    struct ResolveOutput: Codable {
        /// 전체 후보 firstName (dedup, 첫 등장 순서). build-dict 호출 시 인자로 그대로 사용.
        let all: [String]
        /// cache hit (lookup 불필요).
        let hits: [String]
        /// cache miss (LLM이 lookupJiraAccountId MCP 호출 + cache set 필요).
        let misses: [String]
    }

    mutating func run() throws {
        let candidates: [String]
        do {
            candidates = try extractMentionCandidates(input: input, speakerMappingPath: speakerMapping)
        } catch {
            FileHandle.standardError.write(Data("입력 파일 읽기 실패 (\(input)): \(error)\n".utf8))
            throw ExitCode(2)
        }

        let cache = loadCache()
        var hits: [String] = []
        var misses: [String] = []
        for name in candidates {
            let key = normalize(name)
            if cache[key] != nil {
                hits.append(name)
            } else {
                misses.append(name)
            }
        }

        let output = ResolveOutput(all: candidates, hits: hits, misses: misses)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        let data = try encoder.encode(output)
        print(String(data: data, encoding: .utf8) ?? "{}")
    }
}

struct BuildDictCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "build-dict",
        abstract: "후보 이름들로 mention dict JSON 빌드 (publish 스킬 ADF 변환용)"
    )

    @Argument(help: "후보 firstName 목록 — 각각 normalize 후 cache 조회. miss는 자동 제외")
    var names: [String]

    mutating func run() throws {
        let cache = loadCache()
        var dict: [String: MentionEntry] = [:]
        for name in names {
            let key = normalize(name)
            if key.isEmpty { continue }
            if let entry = cache[key] {
                dict[key] = entry
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(dict)
        print(String(data: data, encoding: .utf8) ?? "{}")
    }
}
