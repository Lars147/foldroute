import Foundation

struct TransitReference: Codable, Hashable, Sendable {
    let tripID: String
    let fromID: String
    let toID: String
    let scheduledDeparture: Date
    let scheduledArrival: Date

    static func make(tripID: String?, fromID: String?, toID: String?, departure: Date?, arrival: Date?) -> Self? {
        guard let tripID, !tripID.isEmpty, let fromID, let toID, let departure, let arrival else { return nil }
        return Self(tripID: tripID, fromID: fromID, toID: toID, scheduledDeparture: departure, scheduledArrival: arrival)
    }
}

enum TransitRefreshFailure: String, Codable, Sendable {
    case unavailable, network
}

struct TransitUpdate: Sendable {
    let departure: Date
    let arrival: Date
    var departurePlatform: String?
    var arrivalPlatform: String?
    let isRealtime: Bool
    let isCancelled: Bool
    var receivedAt: Date?
}

enum TransitRefreshResult: Sendable {
    case updated(TransitUpdate)
    case unavailable
    case failed(retryAfter: TimeInterval?)
}

protocol TransitRefreshing: Sendable {
    func refresh(_ legs: [TransitLeg]) async -> [UUID: TransitRefreshResult]
}

struct UnavailableTransitRefresher: TransitRefreshing {
    func refresh(_ legs: [TransitLeg]) async -> [UUID: TransitRefreshResult] {
        Dictionary(uniqueKeysWithValues: legs.map { ($0.id, .unavailable) })
    }
}

enum TransitRefreshPolicy {
    static let interval: TimeInterval = 60
    static let staleAfter: TimeInterval = 120

    static func retryDelay(failures: Int, retryAfter: TimeInterval?) -> TimeInterval {
        max(failures <= 1 ? 120 : failures == 2 ? 240 : 300, retryAfter ?? 0)
    }

    static func retryAfter(_ value: String?, now: Date = Date()) -> TimeInterval? {
        guard let value else { return nil }
        if let seconds = Double(value), seconds.isFinite { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value).map { max(0, $0.timeIntervalSince(now)) }
    }

    static func canUseTimes(_ leg: TransitLeg, now: Date) -> Bool {
        guard !leg.isCancelled, leg.refreshFailure == nil, let updated = leg.lastUpdatedAt else { return false }
        return now.timeIntervalSince(updated) <= staleAfter
    }
}

// A trip contains all stops, not just the user's boarding and alighting stops.
// Scheduled event times disambiguate repeated visits to the same station.
struct RefreshedTransitTrip: Decodable {
    struct Stop: Decodable {
        let stopId: String?
        let arrival: Date?
        let departure: Date?
        let scheduledArrival: Date?
        let scheduledDeparture: Date?
        let track: String?
        let scheduledTrack: String?
        let cancelled: Bool?
    }

    struct Leg: Decodable {
        let from: Stop
        let to: Stop
        let intermediateStops: [Stop]?
        let realTime: Bool?
        let cancelled: Bool?
    }

    let legs: [Leg]

    func update(for reference: TransitReference) -> TransitUpdate? {
        let stops = legs.flatMap { leg in
            ([leg.from] + (leg.intermediateStops ?? []) + [leg.to]).map { ($0, leg) }
        }
        let board = stops.indices.filter {
            stops[$0].0.stopId == reference.fromID && stops[$0].0.scheduledDeparture == reference.scheduledDeparture
        }
        let alight = stops.indices.filter {
            stops[$0].0.stopId == reference.toID && stops[$0].0.scheduledArrival == reference.scheduledArrival
        }
        guard board.count == 1, alight.count == 1, let first = board.first, let last = alight.first, first < last else { return nil }
        let departureStop = stops[first].0
        let arrivalStop = stops[last].0
        let cancelled = stops[first...last].contains { $0.1.cancelled == true }
            || departureStop.cancelled == true || arrivalStop.cancelled == true
        let departure = departureStop.departure ?? departureStop.scheduledDeparture
        let arrival = arrivalStop.arrival ?? arrivalStop.scheduledArrival
        guard let departure, let arrival, arrival >= departure else { return nil }
        return TransitUpdate(
            departure: departure, arrival: arrival,
            departurePlatform: departureStop.track ?? departureStop.scheduledTrack,
            arrivalPlatform: arrivalStop.track ?? arrivalStop.scheduledTrack,
            isRealtime: stops[first].1.realTime == true && stops[last].1.realTime == true,
            isCancelled: cancelled
        )
    }
}

struct TransitDisruption: Equatable {
    let id: String
    let message: String
}

struct NavigationAlternative {
    let journey: Journey
    let progress: NavigationProgress
    let sourceLegID: UUID
    let issueID: String?
    var createdAt: Date = Date()
    var sourceArrival: Date?
}

extension Journey {
    func replacingLegs(_ legs: [JourneyLeg]) -> Journey {
        Journey(
            id: id, origin: origin, destination: destination, waypoint: waypoint,
            departure: legs.first?.startTime ?? departure, arrival: legs.last?.endTime ?? arrival,
            legs: legs, transfers: transfers, isDirect: isDirect,
            score: (legs.last?.endTime ?? arrival).timeIntervalSince1970
        )
    }

    func remainingTransit(from index: Int) -> [TransitLeg] {
        legs.dropFirst(index).compactMap { if case .transit(let leg) = $0 { return leg }; return nil }
    }
}

enum TransitJourneyUpdater {
    static func apply(_ results: [UUID: TransitRefreshResult], to journey: Journey, from index: Int, now: Date) -> Journey {
        var legs = journey.legs
        for i in legs.indices where i >= index {
            guard case .transit(var leg) = legs[i], let result = results[leg.id] else { continue }
            switch result {
            case .updated(let update):
                leg.startTime = update.departure
                leg.endTime = update.arrival
                leg.departurePlatform = update.departurePlatform
                leg.arrivalPlatform = update.arrivalPlatform
                leg.isRealtime = update.isRealtime
                leg.isCancelled = update.isCancelled
                leg.lastUpdatedAt = update.receivedAt ?? now
                leg.refreshFailure = nil
            case .unavailable: leg.refreshFailure = .unavailable
            case .failed: leg.refreshFailure = .network
            }
            legs[i] = .transit(leg)
        }
        // Preserve the current step and its elapsed duration. Reflow only future
        // non-transit steps; transit departures remain fixed to provider times.
        if legs.indices.contains(index), case .wait(let wait) = legs[index],
           let boarding = legs.indices.dropFirst(index + 1).first(where: { legs[$0].kind == .transit }),
           journey.bikeTransferBoardings.contains(boarding) {
            legs[index] = .wait(TransitionLeg(id: wait.id, place: wait.place, startTime: wait.startTime,
                endTime: max(wait.startTime, legs[boarding].startTime)))
        }
        for i in legs.indices where i > index {
            let previousEnd = legs[i - 1].endTime
            let duration = legs[i].endTime.timeIntervalSince(legs[i].startTime)
            switch legs[i] {
            case .transit: break
            case .stop(let transition):
                let minimum = Double(transition.stop?.stayMinutes ?? 0) * 60
                legs[i] = .stop(TransitionLeg(id: transition.id, place: transition.place, startTime: previousEnd, endTime: max(transition.endTime, previousEnd.addingTimeInterval(minimum)), stop: transition.stop))
            case .fold(let transition):
                let nextTransit = legs.indices.dropFirst(i + 1).first { legs[$0].kind == .transit }
                let buffer = nextTransit.map { journey.bikeTransferBoardings.contains($0) ? BikeTransferComposer.buffer : 0 } ?? 0
                let departure = nextTransit.map { legs[$0].startTime.addingTimeInterval(-buffer) } ?? previousEnd
                let start = max(previousEnd, departure.addingTimeInterval(-duration))
                legs[i] = .fold(TransitionLeg(id: transition.id, place: transition.place, startTime: start, endTime: start.addingTimeInterval(duration)))
            case .unfold(let transition):
                legs[i] = .unfold(TransitionLeg(id: transition.id, place: transition.place, startTime: previousEnd, endTime: previousEnd.addingTimeInterval(duration)))
            case .wait(let transition):
                let end = legs.dropFirst(i + 1).first { $0.kind == .transit }?.startTime ?? previousEnd
                legs[i] = .wait(TransitionLeg(id: transition.id, place: transition.place, startTime: previousEnd, endTime: max(previousEnd, end)))
            case .approach, .bike, .walk:
                legs[i] = legs[i].shifted(by: previousEnd.timeIntervalSince(legs[i].startTime))
            }
        }
        return journey.replacingLegs(legs)
    }

    static func disruption(in journey: Journey, from index: Int, now: Date, remainingMovementTime: TimeInterval? = nil) -> TransitDisruption? {
        if let cancelled = journey.remainingTransit(from: index).first(where: \.isCancelled) {
            return TransitDisruption(id: "cancelled-\(cancelled.id)", message: "\(cancelled.line): Fahrt oder benötigter Halt fällt aus.")
        }
        var earliest = now
        var previousTransit = false
        var hasTransferWalk = false
        for i in journey.legs.indices where i >= index {
            let leg = journey.legs[i]
            switch leg {
            case .transit(let transit):
                guard TransitRefreshPolicy.canUseTimes(transit, now: now) else { return nil }
                if i > index {
                    // MOTIS already includes the requested buffer in transfer walks.
                    var buffer: TimeInterval = journey.bikeTransferBoardings.contains(i) || (previousTransit && !hasTransferWalk) ? 180 : 0
                    if journey.legs[index].kind == .wait,
                       journey.legs[(index + 1)..<i].allSatisfy({ $0.kind == .wait }) {
                        buffer = min(buffer, max(0, journey.legs[index].endTime.timeIntervalSince(now)))
                    }
                    if earliest.addingTimeInterval(buffer) > transit.startTime {
                        return TransitDisruption(id: "connection-\(transit.id)", message: "Anschluss an \(transit.line) voraussichtlich nicht erreichbar.")
                    }
                }
                earliest = max(now, transit.endTime)
                previousTransit = true
                hasTransferWalk = false
            case .wait: break
            case .stop(let stop):
                if i == index { earliest = max(now, stop.endTime) }
                else { earliest = max(stop.endTime, earliest.addingTimeInterval(Double(stop.stop?.stayMinutes ?? 0) * 60)) }
                previousTransit = false
                hasTransferWalk = false
            default:
                if i == index {
                    earliest = now.addingTimeInterval(remainingMovementTime ?? max(0, leg.endTime.timeIntervalSince(now)))
                } else {
                    earliest = earliest.addingTimeInterval(max(0, leg.endTime.timeIntervalSince(leg.startTime)))
                }
                if leg.kind == .walk { hasTransferWalk = true }
            }
        }
        return nil
    }
}

struct TransitReminder: Equatable {
    let id: String
    let title: String
    let body: String
    let date: Date

    static func remaining(in journey: Journey, from index: Int, now: Date) -> [TransitReminder] {
        journey.legs.enumerated().flatMap { i, leg -> [TransitReminder] in
            guard i >= index, case .transit(let transit) = leg,
                  TransitRefreshPolicy.canUseTimes(transit, now: now) else { return [] }
            var reminders: [TransitReminder] = []
            if i > index {
                reminders.append(TransitReminder(
                    id: "\(leg.id)-board", title: "\(transit.line) bereit",
                    body: "Richtung \(transit.headsign)\(transit.departurePlatform.map { ", Gleis \($0)" } ?? "")",
                    date: transit.startTime.addingTimeInterval(-120)
                ))
            }
            reminders.append(TransitReminder(
                id: "\(leg.id)-leave", title: "Gleich aussteigen",
                body: "Nächster Abschnitt: \(transit.to.name)", date: transit.endTime.addingTimeInterval(-300)
            ))
            return reminders.filter { $0.date.timeIntervalSince(now) > 1 }
        }
    }
}
