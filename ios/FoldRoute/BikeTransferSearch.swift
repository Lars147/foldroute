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
            if leg.kind == .transit {
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
