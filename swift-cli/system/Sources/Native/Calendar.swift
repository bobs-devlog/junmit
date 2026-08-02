// 참석자는 안정 키(id) + 이메일(확정된 경우만) + EKParticipant.name(원시)을 전달한다.
// 이름 결정(캐시·휴리스틱·fallback)은 프론트엔드가 담당 — id가 안정 키라
// 사용자가 한 번 교정한 이름을 캐시에 귀속할 수 있다. EKParticipant.name은 캘린더 소스에 따라
// 실제 이름일 수도, 이메일로 fallback될 수도 있어 그대로 넘긴다.
//
// "이 참석자가 이메일인가"는 URL 스킴을 볼 수 있는 여기서만 판정한다. 프론트가 문자열로
// 되짚으면 principal URL 같은 값을 이메일로 오인한다.
import EventKit
import Foundation

struct AttendeeDTO: Codable {
    /// 이름 캐시의 안정 키. 보통 이메일이지만 캘린더가 불투명 값을 주기도 한다.
    let id: String
    /// 이메일로 확정됐을 때만 채운다. 아니면 빈 문자열(프론트는 표시·휴리스틱을 건너뜀).
    let email: String
    let name: String
}

private let mailtoPrefix = "mailto:"

// 스킴 없이 주소만 오는 값을 위한 방어용 형태 검사 — 스킴·경로·공백 없는 `local@domain.tld`.
// 사양상 이 형태는 정상 CAL-ADDRESS가 아니지만, EventKit이 스킴 없는 값을 넘겨도 이메일을
// 잃지 않도록 남겨둔다. mailto URL은 이 검사를 거치지 않는다(TLD 없는 사내 도메인도 이메일).
private let emailPattern = "^[^\\s@/:]+@[^\\s@/:]+\\.[^\\s@/:]+$"

/// 이름 캐시 키로 쓸 참석자 식별자 — mailto 접두사만 벗긴 원문.
/// 불투명 값이어도 버리지 않는다. 키가 바뀌면 사용자가 저장해둔 이름이 전부 미아가 된다.
func participantIdentifier(_ url: URL) -> String {
    let raw = url.absoluteString
    guard raw.lowercased().hasPrefix(mailtoPrefix) else { return raw }
    return String(raw.dropFirst(mailtoPrefix.count))
}

/// 참석자 URL이 이메일인지 — 스킴으로 가른다. 문자열에 `@`가 있는지로 되짚으면 안 된다.
///
/// 근거는 사양이다. 참석자 값(CAL-ADDRESS)은 임의의 URI이고, **이메일 주소를 가리킬 때만
/// mailto URI여야 한다**(RFC 5545 §3.3.3). 즉 mailto가 아니면 이메일이 아니다.
/// 이메일이 없는 참석자가 생기는 이유도 사양에 있다 — 캘린더 사용자 주소가 마땅치 않으면
/// 서버가 principal 리소스 URI를 대신 쓸 수 있다(RFC 6638 §2.4.1). 그 값엔 `@`가 섞이기도 한다.
///
/// EventKit은 이메일을 공개 API로 노출하지 않아 이 URL이 유일한 출처다(rdar://35611698).
/// `isCurrentUser`로 본인을 골라내려는 시도도 통하지 않는다 — 참석자에겐 세팅되지 않고
/// 주최자에게만 붙는다(rdar://15396225).
func isEmailParticipant(_ url: URL) -> Bool {
    if url.scheme?.lowercased() == "mailto" { return true }
    guard url.scheme == nil else { return false }
    return participantIdentifier(url).range(of: emailPattern, options: .regularExpression) != nil
}

struct CalendarEventDTO: Codable {
    let title: String
    let time: String
    let attendees: [AttendeeDTO]
    /// 캘린더 description (Google은 HTML로 저장)을 Markdown으로 변환한 결과. 비어있을 수 있음.
    let notes: String
}

struct CalendarFetchResult: Codable {
    let ok: Bool
    let events: [CalendarEventDTO]?
    let error: String?
}

enum CalendarError: String {
    case noPermission = "no_permission"
}

// 마이크 패턴과 동일한 4값 enum: 0=notDetermined, 1=restricted, 2=denied, 3=authorized.
// raw value로 매칭하면 macOS 13/14 case 차이(.authorized vs .fullAccess/.writeOnly) 무관하게 처리.
//   0=notDetermined, 1=restricted, 2=denied,
//   3=authorized(13)/fullAccess(14),
//   4=writeOnly(14, read 불가 → 일정 조회 기준 거부와 동일)
func calendarPermissionStatusInt() -> Int32 {
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0: return 0
    case 1: return 1
    case 2: return 2
    case 3: return 3
    default: return 2
    }
}

func fetchCalendarEventsJSON(dateString: String) -> String {
    let store = EKEventStore()

    // 사전 status 조회로 거부/제한 케이스에서 권한 다이얼로그 트리거 회피.
    // notDetermined일 때만 request 호출 → OS 다이얼로그.
    let statusInt = calendarPermissionStatusInt()
    if statusInt == 1 || statusInt == 2 {
        return encodeResult(CalendarFetchResult(ok: false, events: nil, error: CalendarError.noPermission.rawValue))
    }

    if statusInt == 0 {
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        let completion: (Bool, Error?) -> Void = { g, _ in
            granted = g
            semaphore.signal()
        }
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents(completion: completion)
        } else {
            store.requestAccess(to: .event, completion: completion)
        }
        semaphore.wait()
        guard granted else {
            return encodeResult(CalendarFetchResult(ok: false, events: nil, error: CalendarError.noPermission.rawValue))
        }
    }

    let cal = Calendar.current
    let targetDate: Date = {
        if !dateString.isEmpty {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            if let d = f.date(from: dateString) { return d }
        }
        return Date()
    }()

    // 원격 소스(Google·Exchange 등) 동기화를 촉발 — 계정을 막 추가한 경우 최신 이벤트를 당겨오려는
    // 시도. 단 EventKit 특성상 즉시 반영은 보장되지 않는다(서버 sync는 비동기, 수 초~수 분 지연 가능).
    store.refreshSourcesIfNecessary()

    let startOfDay = cal.startOfDay(for: targetDate)
    let endOfDay = cal.date(byAdding: .day, value: 1, to: startOfDay)!

    let predicate = store.predicateForEvents(withStart: startOfDay, end: endOfDay, calendars: nil)
    let events = store.events(matching: predicate)

    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"

    var dtos: [CalendarEventDTO] = []
    for event in events {
        if event.isAllDay { continue }

        var attendeeList: [AttendeeDTO] = []
        if let attendees = event.attendees {
            for a in attendees {
                if a.participantType == .room || a.participantType == .resource || a.participantType == .group { continue }
                if a.participantStatus == .declined { continue }
                let identifier = participantIdentifier(a.url)
                if identifier.contains("resource.calendar.google.com") ||
                   identifier.contains("group.calendar.google.com") ||
                   identifier.hasPrefix("c_") || identifier.hasPrefix("_") { continue }
                // EKParticipant.name은 캘린더 소스에 따라 실제 이름 또는 이메일 fallback. 원시값 그대로 전달.
                attendeeList.append(AttendeeDTO(
                    id: identifier,
                    email: isEmailParticipant(a.url) ? identifier : "",
                    name: a.name ?? ""
                ))
            }
        }

        let startTime = formatter.string(from: event.startDate)
        let endTime = formatter.string(from: event.endDate)

        let notes = htmlToMarkdown(event.notes ?? "")

        dtos.append(CalendarEventDTO(
            title: event.title ?? "",
            time: "\(startTime)-\(endTime)",
            attendees: attendeeList,
            notes: notes
        ))
    }

    return encodeResult(CalendarFetchResult(ok: true, events: dtos, error: nil))
}

private func encodeResult(_ result: CalendarFetchResult) -> String {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result), let s = String(data: data, encoding: .utf8) {
        return s
    }
    return #"{"ok":false,"error":"encode_failed"}"#
}
