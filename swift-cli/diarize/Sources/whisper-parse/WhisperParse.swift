import Foundation
import ArgumentParser

// whisper.cpp Full JSON (-ojf) → segments.json 변환
//
// 동작:
//  1) whisper.cpp Full JSON 로드 (transcription[] 또는 segments[])
//  2) 각 세그먼트 텍스트 trim, 빈 줄 제외
//  3) 환각 반복 제거:
//     - 동일 텍스트 3회 연속 → 스킵
//     - A-B-A-B 교차 → 3번째부터 스킵
//  4) 무음/크레딧 환각 제거 (--silence-regions 지정 시):
//     - 크레딧 문구 denylist 매칭 ("한글자막 by~"·"다음 영상에서 만나요" 등) → 무조건 드롭
//     - 단독 평범 인사말("감사합니다" 등)인데 세그먼트에 실발화(비무음)가 거의 없으면(무음) → 드롭
//  5) segments.json 저장
//
// 단어(words.json) 출력은 더 이상 생성하지 않는다 — 화자 매칭이 세그먼트 레벨로 전환됐고
// (한국어 whisper 단어 타임스탬프 부정확), 단어 레벨이 오히려 화자를 오귀속한다.
// 화자 매칭은 세그먼트 시간 overlap으로 수행(diarize 바이너리).

// 무음 구간을 whisper가 채우는 한국어 유튜브 자막 크레딧 환각 문구.
// 데이터 전수 + 공개 레퍼런스(유튜브 자막 크레딧 관례)로 컴파일. 모두 실제 회의 발화로는
// 나타나지 않는 특이 문구라 substring 매칭으로 안전하게 드롭한다. ("감사합니다"·"수고하셨습니다"
// 같은 단독 인사말은 실제 발화라 여기 넣지 않고, 무음 음량 게이트로만 거른다.)
let creditHallucinationPhrases = [
    // "자막 제공"/"한글자막 제공"은 "…자막 제공 및 광고를 포함하고 있습니다" 류 유튜브 크레딧 환각을 잡는다.
    // ("광고를 포함" 등은 실제 마케팅 회의 발화로 나올 수 있어 넣지 않음 — 자막 문구로 충분히 걸림.)
    "한글자막 by", "한글자막 제공", "자막 제작", "자막 제공", "자막 by",
    "다음 영상에서 만나", "다음 영상에서 뵙", "다음 시간에 만나", "다음에 또 만나",
    "시청해주셔서 감사", "시청해 주셔서 감사", "봐주셔서 감사",
    "구독과 좋아요", "구독, 좋아요", "좋아요와 구독", "구독 부탁",
]

// 무음 구간에 whisper가 흔히 채우는 평범한 인사말. 이들은 실제 회의 발화로도 자주 쓰여서
// (회의 마무리 인사) 무조건 드롭하면 안 되고, 세그먼트에 실제 소리가 없을(무음) 때만 환각으로
// 본다. 단독 세그먼트(문장 일부가 아닌) 정확 일치일 때만 후보로 본다.
let politeClosingPhrases: Set<String> = [
    "감사합니다", "수고하셨습니다", "고생하셨습니다",
    "감사합니다수고하셨습니다", "수고하셨습니다감사합니다",
]

@main
@available(macOS 14, *)
struct WhisperParse: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "whisper-parse",
        abstract: "whisper.cpp Full JSON → segments.json"
    )

    @Option(name: .shortAndLong, help: "whisper.cpp Full JSON 입력 경로")
    var input: String

    @Option(name: .long, help: "segments.json 출력 경로")
    var segmentsOutput: String

    // 무음 환각 필터 (옵셔널). transcribe.sh가 ffmpeg silencedetect(-50dB)로 구한
    // 무음 구간 JSON([[start,end],...])을 넘기면, 무음/크레딧 환각 세그먼트를 드롭한다.
    @Option(name: .long, help: "무음 구간 JSON 경로 ([[start,end],...]) — 환각 필터용")
    var silenceRegions: String?

    // 평범 인사말("감사합니다" 등) 세그먼트의 실발화(비무음, -50dB 초과) 구간이 이 값(초)
    // 미만이면 무음 환각으로 보고 드롭. 이 게이트는 평범 인사말에만 적용한다 — 일반 세그먼트에
    // 적용하면 짧은 실발화가 순간 트랜지언트만 남아 오드롭되기 때문(실측). 실제 마무리 인사는
    // 또렷하게 발화돼 비무음이 충분하므로 보존된다(34세션 실측: 실제 인사말 21개 전부 보존).
    @Option(name: .long, help: "평범 인사말 유지 최소 비무음 길이(초, 기본 0.3)")
    var minNonsilent: Double = 0.3

    func run() throws {
        let raw = try Data(contentsOf: URL(fileURLWithPath: input))

        // whisper.cpp는 UTF-8 멀티바이트를 토큰 경계에서 분할하여
        // 불완전 바이트가 섞인 상태로 JSON을 출력한다.
        // lenient 디코딩으로 replacement character(�)로 치환한 뒤 파싱.
        let sanitized = Data(String(decoding: raw, as: UTF8.self).utf8)
        guard let json = try JSONSerialization.jsonObject(with: sanitized) as? [String: Any] else {
            throw ValidationError("invalid whisper JSON: root is not an object")
        }

        var segments: [SegRow] = []

        if let trans = json["transcription"] as? [[String: Any]] {
            for seg in trans {
                let rawText = (seg["text"] as? String) ?? ""
                let text = rawText.trimmingCharacters(in: .whitespaces)
                if text.isEmpty { continue }

                let ts = seg["timestamps"] as? [String: Any] ?? [:]
                let startStr = (ts["from"] as? String) ?? "00:00:00,000"
                let endStr = (ts["to"] as? String) ?? "00:00:00,000"
                let segStart = roundTo(parseTs(startStr), 2)
                let segEnd = roundTo(parseTs(endStr), 2)

                // 환각 반복 제거
                // 1) 동일 텍스트 3회 이상 연속 스킵
                if segments.count >= 2,
                   segments[segments.count - 1].text == text,
                   segments[segments.count - 2].text == text {
                    continue
                }
                // 2) A-B-A-B 교차: 3번째부터 스킵
                if segments.count >= 3 {
                    let s1 = segments[segments.count - 1].text
                    let s2 = segments[segments.count - 2].text
                    let s3 = segments[segments.count - 3].text
                    if s2 == text && s1 == s3 && s1 != text {
                        continue
                    }
                }

                segments.append(SegRow(start: segStart, end: segEnd, text: text))
            }
        } else if let segs = json["segments"] as? [[String: Any]] {
            // 대체 포맷 (Whisper segments 레벨만)
            for seg in segs {
                let text = ((seg["text"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
                if text.isEmpty { continue }
                let start = roundTo((seg["start"] as? Double) ?? 0, 2)
                let end = roundTo((seg["end"] as? Double) ?? 0, 2)
                segments.append(SegRow(start: start, end: end, text: text))
            }
        }

        // 크레딧 환각(denylist)은 실제 발화로 절대 나오지 않는 특이 문구라 **항상 무조건 드롭**한다
        // (silence-regions 산출 실패로 fail-open된 경우에도 크레딧 문구는 새지 않게). 반면 평범 인사말
        // ("감사합니다" 등)은 실제 마무리 발화로도 쓰여, silence-regions가 있을 때만 비무음 길이로 거른다.
        let before = segments.count
        let silence = try silenceRegions.map { try loadSilenceRegions($0) }
        segments = segments.filter { seg in
            if isCreditHallucination(seg.text) { return false } // 항상
            if let silence,
               isPoliteClosing(seg.text),
               nonSilentDuration(start: seg.start, end: seg.end, silence: silence) < minNonsilent {
                return false
            }
            return true
        }
        let droppedCount = before - segments.count

        try writeSegmentsJSON(segments, to: segmentsOutput)

        let dropMsg = droppedCount > 0 ? " (환각 \(droppedCount)개 제거)" : ""
        FileHandle.standardError.write(Data(
            "\(segments.count)개 세그먼트 전사 완료\(dropMsg)\n".utf8
        ))
    }
}

// MARK: - Data rows

struct SegRow {
    let start: Double
    let end: Double
    let text: String
}

// MARK: - 무음/크레딧 환각 필터

// ffmpeg silencedetect(-50dB)로 구한 무음 구간 JSON ([[start,end],...]) 로드.
func loadSilenceRegions(_ path: String) throws -> [(Double, Double)] {
    let raw = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let arr = try JSONSerialization.jsonObject(with: raw) as? [[Double]] else {
        throw ValidationError("invalid silence-regions JSON: expected [[start,end],...]")
    }
    return arr.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
}

// 크레딧 환각 문구 매칭 (공백 정규화 후 substring).
func isCreditHallucination(_ text: String) -> Bool {
    let normalized = text.replacingOccurrences(of: " ", with: "")
    for phrase in creditHallucinationPhrases {
        if normalized.contains(phrase.replacingOccurrences(of: " ", with: "")) { return true }
    }
    return false
}

// 평범 인사말 단독 세그먼트 매칭 (공백·끝 구두점 제거 후 정확 일치).
func isPoliteClosing(_ text: String) -> Bool {
    var n = text.replacingOccurrences(of: " ", with: "")
    while let last = n.last, ".!?~,".contains(last) { n.removeLast() }
    return politeClosingPhrases.contains(n)
}

// 세그먼트 [start,end] 중 '무음이 아닌'(실제 소리가 난) 시간.
//   = 세그먼트 길이 − (세그먼트 ∩ 무음구간) 합
// 이 값이 작으면(≈0) 세그먼트 전체가 -50dB 미만이라 실발화가 없었다는 뜻 → 무음 환각.
// 비율이 아니라 절대 시간이라, 긴 세그먼트에 박힌 짧은 실발화도 보존된다.
func nonSilentDuration(start: Double, end: Double, silence: [(Double, Double)]) -> Double {
    let dur = end - start
    guard dur > 0 else { return dur }
    var silent = 0.0
    for (s, e) in silence {
        let overlap = min(end, e) - max(start, s)
        if overlap > 0 { silent += overlap }
    }
    return max(0.0, dur - silent)
}

// MARK: - timestamp parse

// "HH:MM:SS,mmm" 또는 "HH:MM:SS.mmm" → 초(Double)
func parseTs(_ s: String) -> Double {
    let normalized = s.replacingOccurrences(of: ",", with: ".")
    let parts = normalized.split(separator: ":")
    guard parts.count == 3,
          let h = Double(parts[0]),
          let m = Double(parts[1]),
          let sec = Double(parts[2]) else { return 0 }
    return h * 3600 + m * 60 + sec
}

func roundTo(_ v: Double, _ places: Int) -> Double {
    let k = pow(10.0, Double(places))
    return (v * k).rounded() / k
}

// MARK: - JSON 직렬화
// Swift의 JSONSerialization/JSONEncoder는 Double을 full-precision으로 출력하여
// `3.1900000000000004` 같은 노이즈가 발생한다. pyannote/whisper Python 원본의
// `round(x, N) + json.dumps` 결과와 동일한 "3.19" 출력을 위해 수동 빌드한다.

func writeSegmentsJSON(_ rows: [SegRow], to path: String) throws {
    var out = "[\n"
    for (i, r) in rows.enumerated() {
        let comma = i == rows.count - 1 ? "" : ","
        out += "  {\n"
        out += "    \"start\": \(String(format: "%.2f", r.start)),\n"
        out += "    \"end\": \(String(format: "%.2f", r.end)),\n"
        out += "    \"text\": \(jsonString(r.text))\n"
        out += "  }\(comma)\n"
    }
    out += "]\n"
    try out.write(toFile: path, atomically: true, encoding: .utf8)
}

// RFC 8259 JSON 문자열 이스케이프 (non-ASCII는 그대로 UTF-8로 유지)
func jsonString(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        default:
            if c.value < 0x20 {
                out += String(format: "\\u%04x", c.value)
            } else {
                out.unicodeScalars.append(c)
            }
        }
    }
    out += "\""
    return out
}
