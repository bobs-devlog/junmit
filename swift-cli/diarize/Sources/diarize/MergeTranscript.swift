import Foundation

// 화자분리 raw 세그먼트 (pyannote 출력을 int speaker_id로 매핑한 것).
// diarize.json 스키마와 동일한 형태.
struct RawSeg {
    var start: Double
    var end: Double
    var speakerId: Int
}

// 전사 세그먼트 + 화자분리 결과 병합 → transcript.txt, recording.json
//
// 처리 순서 (세그먼트 레벨 화자 매칭):
//  1) 각 whisper 세그먼트에 대해:
//     a) "- A - B" 대시 대화 패턴이면 " - "로 string split. 각 파트의 시간을
//        text 길이 비율로 나누고, 해당 시간 범위의 raw diarize overlap 다수결로 화자 배정.
//        텍스트는 원본 그대로 보존(손상 없음).
//     b) 아니면 세그먼트 전체 시간 범위로 overlap 최대 화자 배정.
//  2) UNKNOWN은 앞/뒤 세그먼트 기준으로 보간
//
// 단어 레벨 매칭은 쓰지 않는다 — 한국어 whisper 단어 타임스탬프가 부정확(무음을 삼켜
// 부풀려짐)해서, 부풀린 단어가 짧게 끼어든 화자 turn으로 번져 발화를 오귀속한다.
// 실측(6개 세션 43건 불일치 100%)에서 단어 레벨이 세그먼트 레벨보다 항상 나쁘거나 동률이었다.
// 세그먼트 시간 범위 overlap이 그 세그먼트를 실제로 지배한 화자를 더 정확히 고른다.

struct AsrSegment: Codable {
    var start: Double
    var end: Double
    var text: String
}

struct MergedSegment: Codable {
    var start: Double
    var end: Double
    var text: String
    var speaker: String
}

struct MergedOutput: Codable {
    var segments: [MergedSegment]
}

enum MergeTranscript {
    static func run(
        diarize: [RawSeg],
        segments: [AsrSegment]
    ) -> [MergedSegment] {
        let starts = diarize.map { $0.start }
        let ends = diarize.map { $0.end }
        let speakers = diarize.map { String(format: "SPEAKER_%02d", $0.speakerId) }

        func findSpeaker(start: Double, end: Double) -> String {
            guard !diarize.isEmpty else { return "UNKNOWN" }
            let rightIdx = bisectLeft(starts, end)
            var bestSpeaker = "UNKNOWN"
            var bestOverlap: Double = 0
            for i in 0..<rightIdx {
                if ends[i] <= start { continue }
                let overlap = min(end, ends[i]) - max(start, starts[i])
                if overlap > bestOverlap {
                    bestOverlap = overlap
                    bestSpeaker = speakers[i]
                }
            }
            return bestSpeaker
        }

        var merged: [MergedSegment] = []

        for seg in segments {
            // 대시 패턴 (- A - B) 분할 시도 — 텍스트 손상 없이 string split
            if let dashSplits = splitByDashPattern(segment: seg, findSpeaker: findSpeaker) {
                merged.append(contentsOf: dashSplits)
                continue
            }
            let speaker = findSpeaker(start: seg.start, end: seg.end)
            merged.append(MergedSegment(
                start: seg.start, end: seg.end, text: seg.text, speaker: speaker
            ))
        }

        // UNKNOWN 보간: 앞뒤가 같은 화자면 그 화자로, 아니면 앞쪽 우선
        for i in merged.indices where merged[i].speaker == "UNKNOWN" {
            let prev: String? = i > 0 ? merged[i - 1].speaker : nil
            let next: String? = i < merged.count - 1 ? merged[i + 1].speaker : nil
            if let p = prev, let n = next, p == n, p != "UNKNOWN" {
                merged[i].speaker = p
            } else if let p = prev, p != "UNKNOWN" {
                merged[i].speaker = p
            } else if let n = next, n != "UNKNOWN" {
                merged[i].speaker = n
            }
        }

        return merged
    }

    // 한국어 whisper가 두 화자의 짧은 교환을 "- A - B" 또는 "- A? - B." 형태로
    // 한 세그먼트에 담는 경우가 있음. " - "로 split하면 텍스트 손상 없이 화자를
    // 나눌 수 있다 (word-level run 분할과 달리 원본 문자 그대로 보존).
    //
    // 각 part의 시간 범위는 text 길이 비율로 추정. 해당 시간 범위의 diarize overlap
    // 최대 화자로 배정.
    //
    // 패턴 아니면 nil 반환 → 상위에서 세그먼트 전체 매칭.
    private static func splitByDashPattern(
        segment: AsrSegment,
        findSpeaker: (Double, Double) -> String
    ) -> [MergedSegment]? {
        let text = segment.text
        guard text.hasPrefix("- ") else { return nil }
        // "- " 이후에 " - "가 있어야 대화 분할 패턴
        let after = String(text.dropFirst(2))
        guard after.contains(" - ") else { return nil }

        let parts = text.components(separatedBy: " - ")
        guard parts.count >= 2 else { return nil }

        // 각 part text 재구성 (첫 것은 "- A" 형태 유지, 나머지는 "- " prefix 다시 추가)
        var partTexts: [String] = []
        for (idx, p) in parts.enumerated() {
            let t = idx == 0 ? p : "- " + p
            let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
            // 빈 파트 또는 대시만 남은 파트("-")는 비정상 — 분할 포기하고 fallback
            if trimmed.isEmpty || trimmed == "-" { return nil }
            partTexts.append(trimmed)
        }

        // 시간 범위 분할: partTexts 길이 비율
        let totalChars = partTexts.reduce(0) { $0 + $1.count }
        guard totalChars > 0 else { return nil }
        let segDuration = segment.end - segment.start

        var result: [MergedSegment] = []
        var cumChars = 0
        for (idx, pt) in partTexts.enumerated() {
            let prevChars = cumChars
            cumChars += pt.count
            let isLast = (idx == partTexts.count - 1)
            let partStart = idx == 0
                ? segment.start
                : segment.start + (Double(prevChars) / Double(totalChars)) * segDuration
            let partEnd = isLast
                ? segment.end
                : segment.start + (Double(cumChars) / Double(totalChars)) * segDuration

            let speaker = findSpeaker(partStart, partEnd)
            result.append(MergedSegment(
                start: partStart, end: partEnd, text: pt, speaker: speaker
            ))
        }

        return result
    }

    // Python bisect.bisect_left 동치: 정렬된 arr에 value를 삽입할 가장 왼쪽 인덱스
    private static func bisectLeft(_ arr: [Double], _ value: Double) -> Int {
        var lo = 0
        var hi = arr.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if arr[mid] < value {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        return lo
    }

    // transcript.txt 포맷: [SPEAKER_XX M:SS] text
    static func renderTranscript(_ segs: [MergedSegment]) -> String {
        var out = ""
        for seg in segs {
            let mins = Int(seg.start) / 60
            let secs = Int(seg.start) % 60
            out += "[\(seg.speaker) \(mins):\(String(format: "%02d", secs))] \(seg.text)\n"
        }
        return out
    }
}
