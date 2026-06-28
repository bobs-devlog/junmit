import Foundation

// MARK: - SPEAKER_XX → 표시 라벨 치환 공유 library
//
// adf(ADF 변환 전 SPEAKER 치환 pre-process)와 mention-cache가 사용.
// 동일 로직을 여러 binary에 복제하지 않도록 SwiftPM library target으로 분리.
//
// 정책 (frontend `src/utils/meetingNotes.ts`의 buildSpeakerLabels·substituteNames와 동등성 유지 필수):
//   - 긴 키부터 치환 (SPEAKER_10이 SPEAKER_1보다 먼저) → prefix 충돌 방지
//   - 매핑된 화자는 실제 이름, name이 빈 문자열인 미매핑 화자는 "참석자 N"으로 치환
//     (N = SPEAKER_XX의 숫자 그대로. SPEAKER_03 → "참석자 3". 라벨이 0부터 연속이라는 실측 기반)
//   - "SPEAKER_\d+" 형식이 아닌 키("_" 접두 메타 등)는 치환에서 제외
//
// 한쪽 변경 시 frontend·sidecar 양쪽 모두 갱신해야 합니다.

public struct SpeakerMap: Sendable {
    /// SPEAKER_XX → 표시 라벨 (매핑된 화자는 이름, 미매핑은 "참석자 N").
    public let entries: [String: String]

    /// speaker_mapping.json 파일에서 로드. 파일이 없으면 빈 매핑 (치환 noop).
    public init(jsonPath: String) throws {
        let url = URL(fileURLWithPath: jsonPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            self.entries = [:]
            return
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            self.entries = [:]
            return
        }
        // 호환: 최상위 직접 매핑 또는 { "speaker_mapping": {...} } 래핑 모두 허용.
        let raw: [String: Any] = (root["speaker_mapping"] as? [String: Any]) ?? root
        self.entries = Self.buildLabels(from: raw)
    }

    /// 빈 매핑 (치환 noop).
    public init() {
        self.entries = [:]
    }

    /// raw speaker_mapping 딕셔너리 → 표시 라벨 매핑.
    /// SPEAKER_\d+ 키만 추려, 매핑된 화자는 이름, 미매핑은 SPEAKER 숫자 그대로 "참석자 N"(SPEAKER_03 → "참석자 3").
    static func buildLabels(from raw: [String: Any]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in raw {
            guard key.hasPrefix("SPEAKER_"),
                  let num = Int(key.dropFirst("SPEAKER_".count)) else { continue }
            let name = (value as? [String: Any])?["name"] as? String ?? ""
            result[key] = name.isEmpty ? "참석자 \(num)" : name
        }
        return result
    }

    /// 같은 디렉토리에서 speaker_mapping.json 자동 검색. 없으면 빈 매핑.
    /// adf가 --input 파일 옆 매핑을 자동 적용할 때 사용.
    public static func autoLoad(fromInputPath inputPath: String) throws -> SpeakerMap {
        let inputUrl = URL(fileURLWithPath: inputPath)
        let mappingPath = inputUrl
            .deletingLastPathComponent()
            .appendingPathComponent("speaker_mapping.json")
            .path
        return try SpeakerMap(jsonPath: mappingPath)
    }

    /// markdown의 SPEAKER_XX 라벨을 표시 라벨(이름 또는 "참석자 N")로 치환. 매핑 없으면 그대로.
    public func substitute(_ markdown: String) -> String {
        if entries.isEmpty { return markdown }
        let sortedKeys = entries.keys.sorted { $0.count > $1.count }
        var result = markdown
        for key in sortedKeys {
            guard let label = entries[key] else { continue }
            result = result.replacingOccurrences(of: key, with: label)
        }
        return result
    }
}
