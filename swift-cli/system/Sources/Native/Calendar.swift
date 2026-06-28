// 참석자는 이메일 + EKParticipant.name(원시)을 그대로 전달한다.
// 이름 결정(캐시·휴리스틱·fallback)은 프론트엔드가 담당 — 이메일이 안정 식별자라
// 사용자가 한 번 교정한 이름을 캐시에 귀속할 수 있다. EKParticipant.name은 캘린더 소스에 따라
// 실제 이름일 수도, 이메일로 fallback될 수도 있어 그대로 넘긴다.
import EventKit
import Foundation

struct AttendeeDTO: Codable {
    let email: String
    let name: String
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
                let email = a.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
                if email.contains("resource.calendar.google.com") ||
                   email.contains("group.calendar.google.com") ||
                   email.hasPrefix("c_") || email.hasPrefix("_") { continue }
                // EKParticipant.name은 캘린더 소스에 따라 실제 이름 또는 이메일 fallback. 원시값 그대로 전달.
                attendeeList.append(AttendeeDTO(email: email, name: a.name ?? ""))
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
