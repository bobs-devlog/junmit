import Foundation
import ArgumentParser

// MARK: - CLI
//
// 화자 분리(diarize)는 Python pyannote.audio가 외부에서 수행하고 diarize.json을
// 생성한다. 이 바이너리는 **merge 전용**:
//  - 입력: diarize.json (raw 화자분리) + segments.json
//  - 처리: 세그먼트 시간 overlap 매칭 + "- A - B" 대시 대화 분할
//  - 출력: diarize.json (후처리 X, 원본 그대로), recording.json, transcript.txt

@main
struct Diarize: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "diarize",
        abstract: "diarize.json + ASR 결과 → transcript.txt 병합"
    )

    @Option(name: .long, help: "화자분리 결과 diarize.json 경로 (pyannote 등이 생성)")
    var diarize: String

    @Option(name: .shortAndLong, help: "출력 diarize.json 경로 (입력을 그대로 복사, 스키마 통일)")
    var output: String

    @Option(name: .long, help: "ASR 세그먼트 JSON 경로 (필수)")
    var segments: String

    @Option(name: .long, help: "transcript.txt 출력 경로")
    var transcript: String?

    @Option(name: .long, help: "recording.json (세그먼트+화자 merge) 출력 경로")
    var recordingJson: String?

    mutating func run() async throws {
        // 1) diarize.json 로드 → [RawSeg]
        let diarData = try Data(contentsOf: URL(fileURLWithPath: diarize))
        let raw = try JSONDecoder().decode([DiarizeInput].self, from: diarData)
            .map { RawSeg(start: $0.start, end: $0.end, speakerId: $0.speaker_id) }
        let speakerCount = Set(raw.map { $0.speakerId }).count
        logMsg("Diarize 입력: \(raw.count) segments, \(speakerCount) speakers")

        // 2) 출력 경로가 입력과 다르면 그대로 복사 (pyannote 스키마 호환성 확인 겸)
        if URL(fileURLWithPath: diarize).standardizedFileURL != URL(fileURLWithPath: output).standardizedFileURL {
            try writeDiarizeJSON(raw, path: output)
        }

        // 3) ASR segments 로드
        let segData = try Data(contentsOf: URL(fileURLWithPath: segments))
        let asrSegments = try JSONDecoder().decode([AsrSegment].self, from: segData)

        // 4) Merge (세그먼트 레벨 화자 매칭 + 대시 분할)
        let merged = MergeTranscript.run(diarize: raw, segments: asrSegments)

        // 5) 출력
        if let recPath = recordingJson {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(MergedOutput(segments: merged))
            try data.write(to: URL(fileURLWithPath: recPath))
        }

        if let trPath = transcript {
            let text = MergeTranscript.renderTranscript(merged)
            try text.write(to: URL(fileURLWithPath: trPath), atomically: true, encoding: .utf8)
        }

        let speakers = Set(merged.map { $0.speaker }).subtracting(["UNKNOWN"])
        let unknown = merged.filter { $0.speaker == "UNKNOWN" }.count
        logMsg("\(merged.count)줄, 화자 \(speakers.count)명, UNKNOWN \(unknown)줄")
    }
}

// diarize.json 입력 포맷: [{ "start": Float, "end": Float, "speaker_id": Int }]
private struct DiarizeInput: Codable {
    let start: Double
    let end: Double
    let speaker_id: Int
}

// MARK: - JSON 출력 (pyannote 스키마 호환)
// diarize.json 포맷: [{ "start": <2자리>, "end": <2자리>, "speaker_id": <int> }]

func writeDiarizeJSON(_ segs: [RawSeg], path: String) throws {
    var out = "[\n"
    for (i, s) in segs.enumerated() {
        let comma = i == segs.count - 1 ? "" : ","
        out += "  {\n"
        out += "    \"start\": \(String(format: "%.2f", s.start)),\n"
        out += "    \"end\": \(String(format: "%.2f", s.end)),\n"
        out += "    \"speaker_id\": \(s.speakerId)\n"
        out += "  }\(comma)\n"
    }
    out += "]\n"
    try out.write(toFile: path, atomically: true, encoding: .utf8)
}

// MARK: - stderr 로그

func logMsg(_ msg: String) {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
}
