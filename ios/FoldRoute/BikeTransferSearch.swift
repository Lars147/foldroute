import Foundation

struct JourneyOptionsUpdate: Sendable {
    var journeys: [Journey]
    var status: BikeTransferSearchStatus
    var issues: [RoutePlannerError] = []
}

enum BikeTransferSearchStatus: Sendable, Equatable {
    case searching, complete, partial
}

extension Journey {
    /// Indices of boardings preceded by riding between two transit legs.
    var bikeTransferBoardings: Set<Int> {
        var seenTransit = false
        var rodeBike = false
        var result: Set<Int> = []
        for (index, leg) in legs.enumerated() {
            if leg.kind == .stop { seenTransit = false; rodeBike = false }
            else if leg.kind == .transit {
                if seenTransit && rodeBike { result.insert(index) }
                seenTransit = true
                rodeBike = false
            } else if leg.kind == .bike && seenTransit {
                rodeBike = true
            }
        }
        return result
    }

    var bikeTransferCount: Int { bikeTransferBoardings.count }
}

struct BikeTransferSeed: Sendable {
    let journey: Journey
    let index: Int
    let request: RouteRequest
    let backwards: Bool

    var outerMode: StreetMode {
        let street = backwards
            ? Array(journey.legs.prefix { $0.kind != .transit })
            : Array(journey.legs.reversed().prefix { $0.kind != .transit })
        return street.contains { $0.kind == .bike || $0.kind == .approach } ? .bike : .walk
    }

    var key: String {
        let point = backwards ? request.destination.coordinate : request.origin.coordinate
        return "\(outerMode.rawValue)|\(backwards)|\(point.latitude)|\(point.longitude)|\(request.timing.date.timeIntervalSince1970)"
    }
}

enum BikeTransferComposer {
    static let buffer: TimeInterval = 180

    static func seeds(_ journeys: [Journey], request: RouteRequest, settings: NavigationSettings, depth: Int) -> [BikeTransferSeed] {
        // Round-robin cut points give each frontier journey a chance within the request budget.
        let lists = journeys.map { journey in
            journey.legs.indices.compactMap { index -> BikeTransferSeed? in
                guard journey.legs[index].kind == .transit else { return nil }
                let leg = journey.legs[index]
                let retained = request.timing.isArrival ? Array(journey.legs[index...]) : Array(journey.legs[...index])
                guard journey.replacingLegs(retained).bikeTransferCount == depth else { return nil }
                let part: RouteRequest
                if request.timing.isArrival {
                    guard request.origin.coordinate.distance(to: leg.startPlace.coordinate) > 100 else { return nil }
                    part = RouteRequest(origin: request.origin, destination: leg.startPlace,
                        timing: .arriveBy(leg.startTime.addingTimeInterval(-settings.foldDuration - buffer)))
                } else {
                    guard leg.endPlace.coordinate.distance(to: request.destination.coordinate) > 100 else { return nil }
                    part = RouteRequest(origin: leg.endPlace, destination: request.destination,
                        timing: .departAt(leg.endTime.addingTimeInterval(settings.unfoldDuration + buffer)))
                }
                return BikeTransferSeed(journey: journey, index: index, request: part, backwards: request.timing.isArrival)
            }
        }
        var result: [BikeTransferSeed] = []
        for index in 0..<(lists.map(\.count).max() ?? 0) {
            for list in lists where list.indices.contains(index) { result.append(list[index]) }
        }
        return result
    }

    static func compose(_ seed: BikeTransferSeed, with part: Journey, request: RouteRequest, settings: NavigationSettings) -> Journey? {
        guard let first = part.legs.firstIndex(where: { $0.kind == .transit }),
              let last = part.legs.lastIndex(where: { $0.kind == .transit }) else { return nil }
        let street = seed.backwards ? Array(part.legs.dropFirst(last + 1)) : Array(part.legs.prefix(first))
        let riding = street.filter { $0.kind == .bike }
        let seconds = riding.reduce(0) { $0 + $1.endTime.timeIntervalSince($1.startTime) }
        guard !riding.isEmpty, seconds > 0, seconds <= Double(settings.maxCyclingMinutes * 60),
              riding.reduce(0, { $0 + $1.distance }) > 0 else { return nil }
        let legs: [JourneyLeg]
        if seed.backwards {
            let boarding = seed.journey.legs[seed.index]
            let foldEnd = boarding.startTime.addingTimeInterval(-buffer)
            let foldStart = foldEnd.addingTimeInterval(-settings.foldDuration)
            guard let end = part.legs.last, end.endTime <= foldStart else { return nil }
            legs = part.legs + [
                .fold(TransitionLeg(place: boarding.startPlace, startTime: foldStart, endTime: foldEnd)),
                .wait(TransitionLeg(place: boarding.startPlace, startTime: foldEnd, endTime: boarding.startTime))
            ] + Array(seed.journey.legs[seed.index...])
        } else {
            let alighting = seed.journey.legs[seed.index]
            let unfoldEnd = alighting.endTime.addingTimeInterval(settings.unfoldDuration)
            // The subquery reserves buffer before its first street leg. Move only the
            // street/fold prefix earlier, leaving that buffer immediately before boarding.
            let approach = part.legs.prefix(first).map { leg -> JourneyLeg in
                if case .fold(let fold) = leg {
                    return .fold(TransitionLeg(id: fold.id, place: fold.place,
                        startTime: fold.startTime.addingTimeInterval(-buffer), endTime: fold.endTime.addingTimeInterval(-buffer)))
                }
                return leg.shifted(by: -buffer)
            }
            guard let start = approach.first, start.startTime >= unfoldEnd else { return nil }
            let boarding = part.legs[first]
            legs = Array(seed.journey.legs[...seed.index]) + [
                .unfold(TransitionLeg(place: alighting.endPlace, startTime: alighting.endTime, endTime: unfoldEnd))
            ] + approach + [
                .wait(TransitionLeg(place: boarding.startPlace, startTime: boarding.startTime.addingTimeInterval(-buffer), endTime: boarding.startTime))
            ] + Array(part.legs[first...])
        }
        guard zip(legs, legs.dropFirst()).allSatisfy({ a, b in
            a.endTime <= b.startTime && a.endPlace.coordinate.distance(to: b.startPlace.coordinate) < 100
        }), let start = legs.first, let end = legs.last else { return nil }
        if request.timing.isArrival {
            guard end.endTime <= request.timing.date else { return nil }
        } else {
            guard start.startTime >= request.timing.date else { return nil }
        }
        let transit = legs.compactMap { if case .transit(let leg) = $0 { return leg }; return nil }
        let tripKeys = transit.map { $0.reference?.tripID ?? "\($0.line)|\($0.from.coordinate)|\($0.startTime)" }
        guard Set(tripKeys).count == tripKeys.count else { return nil }
        let result = Journey(id: "bike-transfer|\(seed.journey.id)|\(seed.index)|\(part.id)",
            origin: request.origin, destination: request.destination,
            departure: start.startTime, arrival: end.endTime, legs: legs,
            transfers: max(0, transit.count - 1), isDirect: false, score: end.endTime.timeIntervalSince1970)
        guard result.bikeTransferCount <= settings.maxBikeTransfers else { return nil }
        return result
    }
}

struct BikeTransferSearch: Sendable {
    typealias Fetch = @Sendable (RouteRequest, Bool, StreetMode) async throws -> [Journey]
    let fetch: Fetch
    var budget: Duration = .seconds(15)
    var fetchUpdate: (@Sendable (RouteRequest, Bool, StreetMode) async throws -> JourneyOptionsUpdate)?

    private enum Event: Sendable {
        case result(Int, JourneyOptionsUpdate)
        case failed(RoutePlannerError)
        case deadline
    }

    func run(base: [Journey], request: RouteRequest, settings: NavigationSettings,
             emit: @Sendable (JourneyOptionsUpdate) -> Void) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: budget)
        var all = base
        var frontier = JourneyOptionSelector.select(from: base.filter { !$0.isDirect }, timing: request.timing)
        var cache: [String: [Journey]] = [:]
        var requested: Set<String> = []
        var partial = false
        var issues: [RoutePlannerError] = []
        var stopped = false
        for depth in 0..<max(0, min(3, settings.maxBikeTransfers)) {
            guard !Task.isCancelled, !frontier.isEmpty, !stopped else { break }
            guard clock.now < deadline else { partial = true; issues.append(.searchDeadline); break }
            let seeds = BikeTransferComposer.seeds(frontier, request: request, settings: settings, depth: depth)
            var generated: [Journey] = []
            var jobs: [BikeTransferSeed] = []
            for seed in seeds {
                if let parts = cache[seed.key] {
                    generated += parts.compactMap { BikeTransferComposer.compose(seed, with: $0, request: request, settings: settings) }
                } else if requested.insert(seed.key).inserted {
                    jobs.append(seed)
                    if jobs.count == 4 { break }
                }
            }
            await withTaskGroup(of: Event.self) { group in
                group.addTask {
                    do { try await clock.sleep(until: deadline) } catch { }
                    return .deadline
                }
                var next = 0
                var pending = 0
                func submit(_ index: Int) {
                    let seed = jobs[index]
                    group.addTask {
                        do {
                            if let fetchUpdate {
                                return .result(index, try await fetchUpdate(seed.request, seed.backwards, seed.outerMode))
                            }
                            return .result(index, JourneyOptionsUpdate(journeys: try await fetch(seed.request, seed.backwards, seed.outerMode), status: .complete))
                        } catch { return .failed(.classify(error)) }
                    }
                }
                while next < min(2, jobs.count) { submit(next); next += 1; pending += 1 }
                while pending > 0, let event = await group.next() {
                    guard !Task.isCancelled else { break }
                    switch event {
                    case .deadline: partial = true; stopped = true; issues.append(.searchDeadline)
                    case .failed(let error): partial = true; stopped = error.stopsRequests; issues.append(error); pending -= 1
                    case .result(let index, let update):
                        let parts = update.journeys
                        issues += update.issues
                        partial = partial || update.status == .partial
                        stopped = update.issues.contains(where: \.stopsRequests)
                        pending -= 1
                        cache[jobs[index].key] = parts
                        generated += parts.compactMap { BikeTransferComposer.compose(jobs[index], with: $0, request: request, settings: settings) }
                    }
                    if stopped { break }
                    if next < jobs.count { submit(next); next += 1; pending += 1 }
                }
                group.cancelAll()
            }
            guard !Task.isCancelled else { return }
            var known = Set(all.map(\.id))
            all += generated.filter { known.insert($0.id).inserted }
            emit(JourneyOptionsUpdate(journeys: all, status: .searching, issues: RoutePlannerError.unique(issues)))
            frontier = JourneyOptionSelector.select(from: generated, timing: request.timing)
        }
        if !Task.isCancelled { emit(JourneyOptionsUpdate(journeys: all, status: partial ? .partial : .complete, issues: RoutePlannerError.unique(issues))) }
    }
}

// Defaults preserve previously encoded settings as well as SwiftData's optional columns.
extension NavigationSettings {
    private enum LegacyKeys: String, CodingKey {
        case foldingDuration, foldDuration, unfoldDuration, cyclingSpeedKilometersPerHour, audioEnabled, hapticsEnabled, excludedTransitModes
        case maxCyclingMinutes, maxWalkingMinutes, maxBikeTransfers, showCyclingComparison
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: LegacyKeys.self)
        self.init()
        showCyclingComparison = try values.decodeIfPresent(Bool.self, forKey: .showCyclingComparison) ?? true
        if let shared = try values.decodeIfPresent(Double.self, forKey: .foldingDuration) {
            foldingDuration = Self.migratedFoldingDuration([shared])
        } else {
            foldingDuration = Self.migratedFoldingDuration([
                try values.decodeIfPresent(Double.self, forKey: .foldDuration),
                try values.decodeIfPresent(Double.self, forKey: .unfoldDuration)
            ].compactMap { $0 })
        }
        cyclingSpeedKilometersPerHour = try values.decodeIfPresent(Double.self, forKey: .cyclingSpeedKilometersPerHour) ?? cyclingSpeedKilometersPerHour
        audioEnabled = try values.decodeIfPresent(Bool.self, forKey: .audioEnabled) ?? audioEnabled
        hapticsEnabled = try values.decodeIfPresent(Bool.self, forKey: .hapticsEnabled) ?? hapticsEnabled
        excludedTransitModes = try values.decodeIfPresent(Set<TransitModePreference>.self, forKey: .excludedTransitModes) ?? []
        maxCyclingMinutes = min(60, max(1, try values.decodeIfPresent(Int.self, forKey: .maxCyclingMinutes) ?? 30))
        maxWalkingMinutes = min(15, max(1, try values.decodeIfPresent(Int.self, forKey: .maxWalkingMinutes) ?? 2))
        maxBikeTransfers = min(3, max(0, try values.decodeIfPresent(Int.self, forKey: .maxBikeTransfers) ?? 2))
    }
}

// A user stop is a boundary between complete trips, not a transfer or an approach waypoint.
extension Journey {
    var stops: [RouteStop] { remainingStops(from: 0) }
    func remainingStops(from index: Int) -> [RouteStop] {
        legs.dropFirst(index).compactMap { if case .stop(let leg) = $0 { return leg.stop }; return nil }
    }
}

actor WaypointRequestBudget {
    private var requests = 0
    private let deadline: Date
    private let maximum: Int
    init(maximum: Int = 64, seconds: TimeInterval = 60) { self.maximum = maximum; deadline = Date().addingTimeInterval(seconds) }
    func take() throws -> TimeInterval {
        let remaining = deadline.timeIntervalSinceNow
        guard requests < maximum, remaining > 0 else { throw RoutePlannerError.stopBudget }
        requests += 1
        return min(20, remaining)
    }
    func check() throws {
        guard requests < maximum, deadline > Date() else { throw RoutePlannerError.stopBudget }
    }
}

enum ViaJourneyComposer {
    static func join(_ first: Journey, _ last: Journey, at stop: RouteStop) -> Journey? {
        guard first.arrival.addingTimeInterval(Double(stop.stayMinutes * 60)) <= last.departure,
              first.destination.coordinate.distance(to: stop.place.coordinate) < 100,
              last.origin.coordinate.distance(to: stop.place.coordinate) < 100 else { return nil }
        return Journey(id: "via|\(first.id)|\(stop.id)|\(stop.stayMinutes)|\(last.id)",
            origin: first.origin, destination: last.destination,
            departure: first.departure, arrival: last.arrival,
            legs: first.legs + [.stop(TransitionLeg(place: stop.place, startTime: first.arrival, endTime: last.departure, stop: stop))] + last.legs,
            transfers: first.transfers + last.transfers, isDirect: first.isDirect && last.isDirect,
            score: last.arrival.timeIntervalSince1970)
    }
}

enum ViaRoutePlanner {
    typealias Fetch = @Sendable (RouteRequest, Bool, WaypointRequestBudget) async throws -> JourneyOptionsUpdate
    private struct Candidate { let journey: Journey; let overLimit: Bool }

    private static func frontier(_ candidates: [Candidate], timing: RouteTiming) -> [Candidate] {
        var seen: Set<String> = []
        let sorted = candidates.sorted { JourneyOptionSelector.comesBefore($0.journey, $1.journey, timing: timing) }
            .filter { seen.insert(JourneyOptionSelector.connectionKey($0.journey)).inserted }
        var result = Array(sorted.filter { !$0.overLimit }.prefix(3))
        if let cycling = sorted.first(where: { $0.journey.isDirect }), !result.contains(where: { $0.journey.id == cycling.journey.id }) { result.append(cycling) }
        return result
    }

    static func run(_ request: RouteRequest, settings: NavigationSettings, budget: WaypointRequestBudget = WaypointRequestBudget(), fetch: Fetch,
                    emit: @Sendable (JourneyOptionsUpdate) -> Void) async throws {
        try RouteStop.validate(request.stops)
        let places = [request.origin] + request.stops.map(\.place) + [request.destination]
        for i in 1..<places.count where places[i-1].coordinate.distance(to: places[i].coordinate) < 30 {
            throw RoutePlannerError.stopSection(i, .placesTooClose)
        }
        let time = request.timing.date
        let backward = request.timing.isArrival
        var completed: [Journey] = [], issues: [RoutePlannerError] = []
        var stopped = false
        for baseOnly in settings.maxBikeTransfers > 0 ? [true, false] : [true] {
            var paths: [Candidate] = []
            for stage in 0..<(places.count-1) {
                if stopped { break }
                let index = backward ? places.count-2-stage : stage
                var additions: [Candidate] = []
                let parents: [Candidate?] = paths.isEmpty ? [nil] : paths.map { Optional($0) }
                for parent in parents {
                    let boundary = parent.map { _ in request.stops[backward ? index : index-1] }
                    let partTime = parent.map {
                        backward ? $0.journey.departure.addingTimeInterval(-Double(boundary!.stayMinutes*60))
                            : $0.journey.arrival.addingTimeInterval(Double(boundary!.stayMinutes*60))
                    } ?? time
                    let part = RouteRequest(origin: places[index], destination: places[index+1], timing: backward ? .arriveBy(partTime) : .departAt(partTime))
                    do {
                        try Task.checkCancellation()
                        try await budget.check()
                        let update = try await fetch(part, baseOnly, budget)
                        issues += update.issues
                        stopped = update.issues.contains(where: \.stopsRequests)
                        for child in update.journeys {
                            let journey = parent.flatMap {
                                backward ? ViaJourneyComposer.join(child, $0.journey, at: boundary!) : ViaJourneyComposer.join($0.journey, child, at: boundary!)
                            } ?? (parent == nil ? child : nil)
                            let over = (parent?.overLimit ?? false) || CyclingComparison.sectionExcess(child, limit: settings.maxCyclingMinutes) > 0
                            guard let journey, !over || journey.isDirect, journey.bikeTransferCount <= settings.maxBikeTransfers else { continue }
                            additions.append(Candidate(journey: journey, overLimit: over))
                        }
                    } catch {
                        try Task.checkCancellation()
                        let cause = RoutePlannerError.classify(error)
                        issues.append(.stopSection(index+1, cause))
                        stopped = cause.stopsRequests
                    }
                    if stage == places.count-2, !additions.isEmpty {
                        completed += additions.map(\.journey)
                        let selected = JourneyOptionSelector.select(from: completed, timing: request.timing, cyclingLimit: settings.maxCyclingMinutes, showCyclingComparison: settings.showCyclingComparison)
                        if !selected.isEmpty { emit(JourneyOptionsUpdate(journeys: selected, status: .searching, issues: RoutePlannerError.unique(issues))) }
                    }
                    if stopped { break }
                }
                paths = frontier(additions, timing: request.timing)
                if paths.isEmpty { break }
            }
            if stopped || !completed.contains(where: { !$0.isDirect }) { break }
        }
        try Task.checkCancellation()
        let selected = JourneyOptionSelector.select(from: completed, timing: request.timing, cyclingLimit: settings.maxCyclingMinutes, showCyclingComparison: settings.showCyclingComparison)
        guard !selected.isEmpty else { throw issues.isEmpty ? RoutePlannerError.noRoute : .multiple(issues) }
        emit(JourneyOptionsUpdate(journeys: selected, status: issues.isEmpty ? .complete : .partial, issues: RoutePlannerError.unique(issues)))
    }
}

extension Journey {
    var walkingSeconds: TimeInterval {
        legs.filter { $0.kind == .walk }.reduce(0) { $0 + $1.endTime.timeIntervalSince($1.startTime) }
    }
}

struct WalkingBlock: Sendable {
    let journey: Journey
    let first: Int
    let last: Int
    let folded: Bool
    let seconds: TimeInterval
}

enum WalkingRouteOptimizer {
    static func blocks(_ journeys: [Journey]) -> [WalkingBlock] {
        var blocks: [WalkingBlock] = []
        for journey in journeys {
            var folded = false, i = 0
            while i < journey.legs.count {
                let leg = journey.legs[i]
                if leg.kind == .fold || leg.kind == .transit { folded = true }
                if leg.kind == .unfold || leg.kind == .stop { folded = false }
                if leg.kind != .walk { i += 1; continue }
                let first = i
                while i + 1 < journey.legs.count && journey.legs[i + 1].kind == .walk { i += 1 }
                let seconds = journey.legs[first...i].reduce(0.0) { $0 + $1.endTime.timeIntervalSince($1.startTime) }
                if seconds > 0 { blocks.append(WalkingBlock(journey: journey, first: first, last: i, folded: folded, seconds: seconds)) }
                i += 1
            }
        }
        return blocks.sorted {
            if $0.seconds != $1.seconds { return $0.seconds > $1.seconds }
            if $0.journey.id != $1.journey.id { return $0.journey.id < $1.journey.id }
            return $0.first < $1.first
        }
    }

    static func replacing(_ block: WalkingBlock, with ride: Journey, settings: NavigationSettings) -> Journey? {
        let journey = block.journey, original = journey.legs
        let from = original[block.first].startPlace, to = original[block.last].endPlace
        let lower = block.first > 0 ? original[block.first - 1].endTime : journey.departure
        let upper = block.last + 1 < original.count ? original[block.last + 1].startTime : journey.arrival
        let unfold = block.folded ? settings.unfoldDuration : 0
        let fold = block.folded ? settings.foldDuration : 0
        let buffer: TimeInterval = block.folded ? 180 : 0
        guard let first = ride.legs.first, let last = ride.legs.last,
              ride.legs.contains(where: { $0.kind == .bike }),
              ride.legs.allSatisfy({ $0.kind == .bike || $0.kind == .walk }),
              ride.departure >= lower.addingTimeInterval(unfold),
              ride.arrival.addingTimeInterval(fold + buffer) <= upper,
              first.startPlace.coordinate.distance(to: from.coordinate) <= 30,
              last.endPlace.coordinate.distance(to: to.coordinate) <= 30 else { return nil }
        var replacement: [JourneyLeg] = []
        if block.folded { replacement.append(.unfold(TransitionLeg(place: from, startTime: lower, endTime: lower.addingTimeInterval(unfold)))) }
        replacement += ride.legs
        if block.folded { replacement.append(.fold(TransitionLeg(place: to, startTime: ride.arrival, endTime: ride.arrival.addingTimeInterval(fold)))) }
        let end = ride.arrival.addingTimeInterval(fold)
        if block.last + 1 < original.count && end < upper { replacement.append(.wait(TransitionLeg(place: to, startTime: end, endTime: upper))) }
        let legs = Array(original.prefix(block.first)) + replacement + Array(original.dropFirst(block.last + 1))
        var cycling: TimeInterval = 0
        for (i, leg) in legs.enumerated() {
            guard leg.startTime.timeIntervalSince1970.isFinite, leg.endTime.timeIntervalSince1970.isFinite,
                  leg.endTime >= leg.startTime else { return nil }
            if i > 0 && (legs[i - 1].endTime > leg.startTime || legs[i - 1].endPlace.coordinate.distance(to: leg.startPlace.coordinate) > 30) { return nil }
            if leg.kind == .transit || leg.kind == .stop { cycling = 0 }
            if leg.kind == .bike || leg.kind == .approach { cycling += leg.endTime.timeIntervalSince(leg.startTime) }
            if cycling > Double(settings.maxCyclingMinutes * 60) { return nil }
        }
        let result = Journey(id: "\(journey.id)|ride:\(block.first)-\(block.last):\(ride.id)", origin: journey.origin, destination: journey.destination,
            waypoint: journey.waypoint, departure: legs[0].startTime, arrival: legs[legs.count - 1].endTime,
            legs: legs, transfers: journey.transfers, isDirect: journey.isDirect, score: journey.score)
        guard result.departure >= journey.departure, result.arrival <= journey.arrival,
              result.walkingSeconds < journey.walkingSeconds, result.bikeTransferCount <= settings.maxBikeTransfers else { return nil }
        return result
    }

    private struct Job: Sendable { var blocks: [WalkingBlock]; let request: RouteRequest }
    private enum Event: Sendable { case deadline, routes(Int, [Journey]), failed(RoutePlannerError) }
    static func run(_ journeys: [Journey], request: RouteRequest, settings: NavigationSettings,
                    fetch: @escaping @Sendable (RouteRequest) async throws -> [Journey],
                    emit: @Sendable ([Journey], [RoutePlannerError]) -> Void) async throws -> [Journey] {
        let selected = JourneyOptionSelector.select(from: journeys.filter { !$0.isDirect }, timing: request.timing,
            cyclingLimit: settings.maxCyclingMinutes, showCyclingComparison: false)
        var jobs: [Job] = [], keys: [String: Int] = [:]
        for block in blocks(Array(selected.prefix(3))) {
            let lower = block.first > 0 ? block.journey.legs[block.first - 1].endTime : block.journey.departure
            let from = block.journey.legs[block.first].startPlace, to = block.journey.legs[block.last].endPlace
            let time = lower.addingTimeInterval(block.folded ? settings.unfoldDuration : 0)
            let key = "\(from.transitStopID ?? "\(from.coordinate)")|\(to.transitStopID ?? "\(to.coordinate)")|\(time.timeIntervalSince1970)"
            if let index = keys[key] { jobs[index].blocks.append(block) }
            else if jobs.count < 6 {
                keys[key] = jobs.count
                jobs.append(Job(blocks: [block], request: RouteRequest(origin: from, destination: to, timing: .departAt(time))))
            }
        }
        guard !jobs.isEmpty else { return journeys }
        return try await withThrowingTaskGroup(of: Event.self) { group in
            group.addTask { try await Task.sleep(for: .seconds(10)); return .deadline }
            var next = 0, pending = 0
            var latest = Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0) })
            var result = journeys, issues: [RoutePlannerError] = []
            func submit(_ index: Int) {
                let part = jobs[index].request
                group.addTask {
                    do { return .routes(index, try await fetch(part)) }
                    catch { try Task.checkCancellation(); return .failed(RoutePlannerError.classify(error)) }
                }
            }
            while next < min(2, jobs.count) { submit(next); next += 1; pending += 1 }
            defer { group.cancelAll() }
            while let event = try await group.next() {
                try Task.checkCancellation()
                if case .deadline = event { break }
                pending -= 1
                switch event {
                case .routes(let index, let rides):
                    for original in jobs[index].blocks {
                        guard let current = latest[original.journey.id],
                              let first = current.legs.firstIndex(where: { $0.id == original.journey.legs[original.first].id }),
                              let last = current.legs.firstIndex(where: { $0.id == original.journey.legs[original.last].id }) else { continue }
                        let block = WalkingBlock(journey: current, first: first, last: last, folded: original.folded, seconds: original.seconds)
                        let candidates = rides.compactMap { replacing(block, with: $0, settings: settings) }
                        if let best = candidates.sorted(by: { JourneyOptionSelector.comesBefore($0, $1, timing: request.timing) }).first {
                            latest[original.journey.id] = best
                            result.append(best)
                        }
                    }
                case .failed(let error):
                    if error != .noRoute && error != .stopBudget { issues.append(error) }
                    if error.stopsRequests { emit(result, RoutePlannerError.unique(issues)); return result }
                case .deadline: break
                }
                emit(result, RoutePlannerError.unique(issues))
                if next < jobs.count { submit(next); next += 1; pending += 1 }
                if pending == 0 { break }
            }
            return result
        }
    }
}
