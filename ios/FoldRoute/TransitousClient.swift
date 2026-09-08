import Foundation

enum StreetMode: String, Sendable {
    case walk = "WALK"
    case bike = "BIKE"
}

struct TransitousClient: JourneyPlanning, TransitRefreshing, @unchecked Sendable {
    enum RequestKind: Sendable {
        case multimodal
        case directBike
    }

    let planningPause: PlanningServerPause
    private let session: URLSession
    private let baseURL: URL
    private let userAgent: String
    private var preTransitMode: StreetMode = .bike
    private var postTransitMode: StreetMode = .bike
    private var preTransitLimit: Int?
    private var postTransitLimit: Int?

    init(
        session: URLSession = .shared,
        baseURL: URL = URL(string: "https://api.transitous.org/api/v6/plan")!,
        userAgent: String? = nil,
        planningPause: PlanningServerPause = .shared
    ) {
        self.session = session
        self.planningPause = planningPause
        self.baseURL = baseURL
        if let userAgent {
            self.userAgent = userAgent
        } else {
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1"
            let contact = Bundle.main.object(forInfoDictionaryKey: "TransitousContact") as? String ?? "https://github.com/Lars147/foldroute"
            self.userAgent = "FoldRoute/\(version) (\(contact))"
        }
    }

    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        guard let journey = try await planAlternatives(request, settings: settings).first else {
            throw RoutePlannerError.noRoute
        }
        return journey
    }

    func planAlternatives(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> [Journey] {
        var result: [Journey] = []
        for try await update in alternativeUpdates(request, settings: settings) {
            result = JourneyOptionSelector.select(from: update.journeys, timing: request.timing)
        }
        return result
    }

    func alternativeUpdates(_ request: RouteRequest, settings: NavigationSettings) -> AsyncThrowingStream<JourneyOptionsUpdate, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let fixedRequest = RouteRequest(origin: request.origin, destination: request.destination,
                        timing: request.timing == .leaveNow ? .departAt(Date()) : request.timing)
                    let result = try await baseAlternatives(fixedRequest, settings: settings) {
                        continuation.yield(JourneyOptionsUpdate(journeys: $0, status: .searching))
                    }
                    let base = result.journeys
                    try Task.checkCancellation()
                    let enabled = !result.rateLimited && settings.maxBikeTransfers > 0 && base.contains { !$0.isDirect }
                    continuation.yield(JourneyOptionsUpdate(journeys: base, status: enabled ? .searching : (result.partial ? .partial : .complete), issues: result.issues))
                    if enabled {
                        var search = BikeTransferSearch { part, backwards, outerMode in
                            var client = self
                            if backwards {
                                client.preTransitMode = outerMode
                                client.postTransitLimit = settings.maxBikeTransferMinutes * 60
                            } else {
                                client.postTransitMode = outerMode
                                client.preTransitLimit = settings.maxBikeTransferMinutes * 60
                            }
                            return try await client.fetchTransitResult(request: part, settings: settings, requestedDate: part.timing.date).get()
                        }
                        search.fetchUpdate = { part, backwards, outerMode in
                            var client = self
                            if backwards {
                                client.preTransitMode = outerMode
                                client.postTransitLimit = settings.maxBikeTransferMinutes * 60
                            } else {
                                client.postTransitMode = outerMode
                                client.preTransitLimit = settings.maxBikeTransferMinutes * 60
                            }
                            let batch = try await client.fetchResult(kind: .multimodal, request: part,
                                settings: settings, requestedDate: part.timing.date).get()
                            return JourneyOptionsUpdate(journeys: batch.journeys,
                                status: batch.allIssues.isEmpty ? .complete : .partial, issues: batch.allIssues)
                        }
                        await search.run(base: base, request: fixedRequest, settings: settings) { update in
                            var update = update
                            update.issues = RoutePlannerError.unique(result.issues + update.issues)
                            if result.partial && update.status == .complete { update.status = .partial }
                            continuation.yield(update)
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private struct FetchBatch: Sendable {
        var journeys: [Journey] = []
        var rejectedGeometry = false
        var issues: [RoutePlannerError] = []
        var allIssues: [RoutePlannerError] { RoutePlannerError.unique(issues + (rejectedGeometry ? [.invalidRouteGeometry] : [])) }
        var recoveryDeparture: Date?
        var rateLimited = false
    }

    private struct BaseResult: Sendable {
        var journeys: [Journey] = []
        var partial = false
        var issues: [RoutePlannerError] = []
        var rateLimited = false
    }

    private func baseAlternatives(
        _ request: RouteRequest, settings: NavigationSettings,
        emit: @Sendable ([Journey]) -> Void
    ) async throws -> BaseResult {
        let variants: [(RequestKind, StreetMode, StreetMode)] = settings.allowedTransitModes.isEmpty
            ? [(.directBike, .bike, .bike)]
            : [(.directBike, .bike, .bike), (.multimodal, .walk, .walk),
               (.multimodal, .bike, .bike), (.multimodal, .walk, .bike), (.multimodal, .bike, .walk)]
        return try await withThrowingTaskGroup(of: (Int, Result<FetchBatch, RoutePlannerError>).self) { group in
            var result = BaseResult()
            var next = 0
            var directFinished = false
            func submit(_ index: Int) {
                let variant = variants[index]
                group.addTask {
                    var client = self
                    client.preTransitMode = variant.1
                    client.postTransitMode = variant.2
                    let response = await client.fetchResult(kind: variant.0, request: request,
                        settings: settings, requestedDate: request.timing.date)
                    return (index, response)
                }
            }
            while next < min(2, variants.count) { submit(next); next += 1 }
            while let (index, response) = try await group.next() {
                try Task.checkCancellation()
                if index == 0 { directFinished = true }
                switch response {
                case .success(let batch):
                    result.journeys += batch.journeys
                    result.issues = RoutePlannerError.unique(result.issues + batch.allIssues)
                    result.partial = !result.issues.isEmpty
                    if batch.rateLimited || batch.allIssues.contains(where: \.stopsRequests) {
                        result.rateLimited = true
                        group.cancelAll()
                    }
                case .failure(let error):
                    result.partial = true
                    result.issues = RoutePlannerError.unique(result.issues + [error])
                    if error.stopsRequests {
                        result.rateLimited = true
                        group.cancelAll()
                    }
                }
                if directFinished && !result.journeys.isEmpty { emit(result.journeys) }
                if result.rateLimited { break }
                if next < variants.count { submit(next); next += 1 }
            }
            try Task.checkCancellation()
            guard !result.journeys.isEmpty else { throw result.issues.count == 1 ? result.issues[0] : (result.issues.isEmpty ? RoutePlannerError.noRoute : .multiple(result.issues)) }
            return result
        }
    }

    private func fetchTransitResult(
        request: RouteRequest,
        settings: NavigationSettings,
        requestedDate: Date
    ) async -> Result<[Journey], RoutePlannerError> {
        guard !settings.allowedTransitModes.isEmpty else { return .success([]) }
        return await fetchResult(
            kind: .multimodal,
            request: request,
            settings: settings,
            requestedDate: requestedDate
        ).map(\.journeys)
    }

    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        let result = await fetchResult(
            kind: .directBike,
            request: request,
            settings: settings,
            requestedDate: request.timing.date
        )
        try Task.checkCancellation()
        switch result {
        case .success(let batch):
            guard
                let journey = JourneyOptionSelector.select(
                    from: batch.journeys,
                    timing: request.timing,
                    maximumOptions: 1
                ).first
            else { throw RoutePlannerError.noRoute }
            return journey
        case .failure(let error):
            throw error
        }
    }

    func refresh(_ legs: [TransitLeg]) async -> [UUID: TransitRefreshResult] {
        var results: [UUID: TransitRefreshResult] = [:]
        for leg in legs where leg.reference == nil { results[leg.id] = .unavailable }
        let groups = Dictionary(grouping: legs.filter { $0.reference != nil }) { $0.reference!.tripID }
        for tripID in groups.keys.sorted() {
            guard !Task.isCancelled else { break }
            let group = groups[tripID]!
            var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
            components.path = "/api/v6/trip"
            components.queryItems = [
                URLQueryItem(name: "tripId", value: tripID),
                URLQueryItem(name: "detailedLegs", value: "false"),
                URLQueryItem(name: "withScheduledSkippedStops", value: "true"),
                URLQueryItem(name: "language", value: "de")
            ]
            var request = URLRequest(url: components.url!)
            request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 20
            request.cachePolicy = .reloadIgnoringLocalCacheData
            do {
                let (data, response) = try await session.data(for: request)
                try Task.checkCancellation()
                guard let response = response as? HTTPURLResponse else { throw RoutePlannerError.invalidResponse }
                if response.statusCode == 429 || response.statusCode == 503 {
                    let retry = TransitRefreshPolicy.retryAfter(response.value(forHTTPHeaderField: "Retry-After"))
                    for leg in legs where results[leg.id] == nil { results[leg.id] = .failed(retryAfter: retry) }
                    break
                }
                if [400, 404, 422].contains(response.statusCode) {
                    for leg in group { results[leg.id] = .unavailable }
                    continue
                }
                guard (200..<300).contains(response.statusCode) else { throw RoutePlannerError.serviceUnavailable }
                let trip = try Self.decoder.decode(RefreshedTransitTrip.self, from: data)
                for leg in group {
                    guard let update = trip.update(for: leg.reference!) else {
                        results[leg.id] = .unavailable
                        continue
                    }
                    var corrected = update
                    corrected.receivedAt = Date()
                    corrected.departurePlatform = correctedPlatform(stopId: leg.reference?.fromID, rawPlatform: update.departurePlatform)
                    corrected.arrivalPlatform = correctedPlatform(stopId: leg.reference?.toID, rawPlatform: update.arrivalPlatform)
                    results[leg.id] = .updated(corrected)
                }
            } catch {
                guard !Task.isCancelled else { break }
                for leg in group { results[leg.id] = .failed(retryAfter: nil) }
            }
        }
        return results
    }

    private func fetchResult(
        kind: RequestKind,
        request: RouteRequest,
        settings: NavigationSettings,
        requestedDate: Date
    ) async -> Result<FetchBatch, RoutePlannerError> {
        do {
            return .success(
                try await fetch(
                    kind: kind,
                    request: request,
                    settings: settings,
                    requestedDate: requestedDate
                )
            )
        } catch {
            return .failure(.classify(error))
        }
    }

    private func fetch(
        kind: RequestKind,
        request: RouteRequest,
        settings: NavigationSettings,
        requestedDate: Date
    ) async throws -> FetchBatch {
        let first = try await fetchOnce(kind: kind, request: request, settings: settings, requestedDate: requestedDate)
        guard first.rejectedGeometry else { return first }
        try Task.checkCancellation()
        // Backward street routing can return both halves in the wrong order, including the turns.
        // Recompute forwards rather than attempting to reorder geometry or shift returned times.
        let forward = kind == .directBike && request.timing.isArrival && first.recoveryDeparture != nil
        let retryRequest = forward
            ? RouteRequest(origin: request.origin, destination: request.destination,
                           timing: .departAt(first.recoveryDeparture!))
            : request
        let retryDate = forward ? first.recoveryDeparture! : requestedDate
        do {
            var retry = try await fetchOnce(kind: kind, request: retryRequest, settings: settings,
                                           requestedDate: retryDate, bypassCache: true)
            try Task.checkCancellation()
            if forward {
                retry.journeys = retry.journeys.filter {
                    $0.departure >= retryDate && $0.arrival <= requestedDate && $0.arrival >= $0.departure
                }
            }
            // Preserve valid alternatives from the first response even if the retry changes or omits them.
            retry.rejectedGeometry = retry.rejectedGeometry || retry.journeys.isEmpty
            let retryIDs = Set(retry.journeys.map(\.id))
            retry.journeys += first.journeys.filter { !retryIDs.contains($0.id) }
            guard !retry.journeys.isEmpty else { throw RoutePlannerError.invalidRouteGeometry }
            return retry
        } catch {
            try Task.checkCancellation()
            guard !first.journeys.isEmpty else { throw error }
            var retained = first
            retained.issues.append(.classify(error))
            retained.rateLimited = RoutePlannerError.classify(error).stopsRequests
            return retained
        }
    }

    private func fetchOnce(
        kind: RequestKind,
        request: RouteRequest,
        settings: NavigationSettings,
        requestedDate: Date,
        bypassCache: Bool = false
    ) async throws -> FetchBatch {
        let url = try makeURL(
            kind: kind,
            request: request,
            settings: settings,
            requestedDate: requestedDate
        )
        var urlRequest = URLRequest(url: url)
        urlRequest.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        urlRequest.timeoutInterval = 20
        if bypassCache { urlRequest.cachePolicy = .reloadIgnoringLocalCacheData }

        try Task.checkCancellation()
        try planningPause.check()
        let (data, response) = try await session.data(for: urlRequest)
        try Task.checkCancellation()
        guard let httpResponse = response as? HTTPURLResponse else {
            throw RoutePlannerError.invalidResponse
        }
        if [429, 503].contains(httpResponse.statusCode),
           let delay = TransitRefreshPolicy.retryAfter(httpResponse.value(forHTTPHeaderField: "Retry-After")), delay > 0 {
            let retryAt = Date().addingTimeInterval(delay)
            planningPause.record(retryAt: retryAt)
            throw RoutePlannerError.multiple([httpResponse.statusCode == 429 ? .rateLimited : .serviceUnavailable, .serverPause(retryAt)])
        }
        switch httpResponse.statusCode {
        case 200..<300: break
        case 429: throw RoutePlannerError.rateLimited
        case 500..<600: throw RoutePlannerError.serviceUnavailable
        default: throw RoutePlannerError.invalidResponse
        }

        let responseDTO: MOTISPlanResponse
        do {
            responseDTO = try Self.decoder.decode(MOTISPlanResponse.self, from: data)
        } catch {
            throw RoutePlannerError.invalidResponse
        }

        let rawJourneys = kind == .multimodal ? responseDTO.itineraries : responseDTO.direct
        var batch = FetchBatch()
        for raw in rawJourneys {
            try Task.checkCancellation()
            guard !raw.legs.contains(where: { $0.cancelled == true }) else { continue }
            do {
                if let journey = try mapJourney(raw, kind: kind, request: request, settings: settings) {
                    batch.journeys.append(journey)
                }
            } catch RoutePlannerError.invalidRouteGeometry {
                batch.rejectedGeometry = true
                if raw.startTime <= raw.endTime && raw.startTime <= requestedDate {
                    batch.recoveryDeparture = max(batch.recoveryDeparture ?? raw.startTime, raw.startTime)
                }
            } catch is PolylineDecodingError {
                batch.rejectedGeometry = true
                if raw.startTime <= raw.endTime && raw.startTime <= requestedDate {
                    batch.recoveryDeparture = max(batch.recoveryDeparture ?? raw.startTime, raw.startTime)
                }
            }
        }
        return batch
    }

    private func makeURL(
        kind: RequestKind,
        request: RouteRequest,
        settings: NavigationSettings,
        requestedDate: Date
    ) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw RoutePlannerError.invalidResponse
        }

        let providerDate: Date
        switch (kind, request.timing) {
        case (.multimodal, .arriveBy):
            providerDate = requestedDate.addingTimeInterval(-settings.unfoldDuration)
        case (.multimodal, _):
            providerDate = requestedDate.addingTimeInterval(settings.foldDuration)
        case (.directBike, _):
            providerDate = requestedDate
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let coordinate: (Coordinate) -> String = {
            String(format: "%.6f,%.6f", locale: Locale(identifier: "en_US_POSIX"), $0.latitude, $0.longitude)
        }

        var items = [
            URLQueryItem(name: "fromPlace", value: coordinate(request.origin.coordinate)),
            URLQueryItem(name: "toPlace", value: coordinate(request.destination.coordinate)),
            URLQueryItem(name: "time", value: formatter.string(from: providerDate)),
            URLQueryItem(name: "arriveBy", value: request.timing.isArrival ? "true" : "false"),
            URLQueryItem(
                name: "cyclingSpeed",
                value: String(
                    format: "%.3f",
                    locale: Locale(identifier: "en_US_POSIX"),
                    settings.cyclingSpeedMetersPerSecond
                )
            ),
            URLQueryItem(name: "detailedLegs", value: "true"),
            URLQueryItem(name: "realtimeMode", value: "REALTIME"),
            URLQueryItem(name: "language", value: "de")
        ]

        switch kind {
        case .multimodal:
            items += [
                URLQueryItem(
                    name: "transitModes",
                    value: settings.allowedTransitModes.joined(separator: ",")
                ),
                URLQueryItem(name: "directModes", value: ""),
                URLQueryItem(name: "preTransitModes", value: preTransitMode.rawValue),
                URLQueryItem(name: "postTransitModes", value: postTransitMode.rawValue),
                // MOTIS expects transfer time in minutes; street-leg limits below use seconds.
                URLQueryItem(name: "additionalTransferTime", value: "3"),
                URLQueryItem(name: "maxPreTransitTime", value: String(preTransitLimit ?? (preTransitMode == .walk ? min(15, max(1, settings.maxWalkingMinutes)) * 60 : min(60, max(5, settings.maxCyclingAccessMinutes)) * 60))),
                URLQueryItem(name: "maxPostTransitTime", value: String(postTransitLimit ?? (postTransitMode == .walk ? min(15, max(1, settings.maxWalkingMinutes)) * 60 : min(60, max(5, settings.maxCyclingAccessMinutes)) * 60))),
                URLQueryItem(name: "requireBikeTransport", value: "false")
            ]
        case .directBike:
            items += [
                URLQueryItem(name: "transitModes", value: ""),
                URLQueryItem(name: "directModes", value: "BIKE"),
                URLQueryItem(name: "maxDirectTime", value: "7200")
            ]
        }

        components.queryItems = items
        guard let url = components.url else { throw RoutePlannerError.invalidResponse }
        return url
    }

    private func mapJourney(
        _ raw: MOTISItinerary,
        kind: RequestKind,
        request: RouteRequest,
        settings: NavigationSettings
    ) throws -> Journey? {
        guard !raw.legs.isEmpty else { return nil }
        let mapped = try raw.legs.map { try mapLeg($0, request: request) }

        let normalized: [JourneyLeg]
        if kind == .multimodal,
           let firstTransit = mapped.firstIndex(where: { $0.kind == .transit }),
           let lastTransit = mapped.lastIndex(where: { $0.kind == .transit }) {
            // Enforce the foot limit on actual street movement, excluding waits and folding.
            func validStreet(_ legs: ArraySlice<JourneyLeg>, mode: StreetMode) -> Bool {
                guard mode == .walk else { return true }
                guard !legs.contains(where: { $0.kind == .bike }) else { return false }
                let seconds = legs.filter { $0.kind == .walk }.reduce(0.0) {
                    $0 + $1.endTime.timeIntervalSince($1.startTime)
                }
                return seconds <= Double(min(15, max(1, settings.maxWalkingMinutes)) * 60)
            }
            guard validStreet(mapped[..<firstTransit], mode: preTransitMode),
                  validStreet(mapped[(lastTransit + 1)...], mode: postTransitMode) else { return nil }
            var result: [JourneyLeg] = []
            for index in mapped.indices {
                if index == firstTransit {
                    let transitStart = mapped[index].startTime
                    result.append(
                        .fold(
                            TransitionLeg(
                                place: mapped[index].startPlace,
                                startTime: transitStart.addingTimeInterval(-settings.foldDuration),
                                endTime: transitStart
                            )
                        )
                    )
                }

                let leg: JourneyLeg
                if index < firstTransit {
                    leg = mapped[index].shifted(by: -settings.foldDuration)
                } else if index > lastTransit {
                    leg = mapped[index].shifted(by: settings.unfoldDuration)
                } else {
                    leg = mapped[index]
                }
                result.append(leg)

                if index == lastTransit {
                    let transitEnd = mapped[index].endTime
                    result.append(
                        .unfold(
                            TransitionLeg(
                                place: mapped[index].endPlace,
                                startTime: transitEnd,
                                endTime: transitEnd.addingTimeInterval(settings.unfoldDuration)
                            )
                        )
                    )
                }
            }
            normalized = result
        } else {
            normalized = mapped
        }

        guard let departure = normalized.first?.startTime,
              let arrival = normalized.last?.endTime else { return nil }
        return Journey(
            id: kind == .multimodal ? "\(raw.id)|\(preTransitMode.rawValue)|\(postTransitMode.rawValue)" : raw.id,
            origin: request.origin,
            destination: request.destination,
            departure: departure,
            arrival: arrival,
            legs: normalized,
            transfers: raw.transfers,
            isDirect: kind == .directBike,
            score: arrival.timeIntervalSince1970
        )
    }

    private func mapLeg(_ raw: MOTISLeg, request: RouteRequest) throws -> JourneyLeg {
        let from = mapPlace(raw.from, fallback: request.origin, endpointName: "START")
        let to = mapPlace(raw.to, fallback: request.destination, endpointName: "END")
        let geometry = try raw.legGeometry.map {
            try PolylineDecoder.decode($0.points, precision: $0.precision)
        } ?? []

        if raw.mode == "BIKE" || raw.mode == "WALK" {
            // Validate raw steps before straight maneuvers are merged; merging must not hide gaps.
            let decodedSteps = try (raw.steps ?? []).map {
                StreetGeometryValidator.Step(
                    direction: ManeuverDirection(rawValue: $0.relativeDirection) ?? .straight,
                    distance: $0.distance, streetName: $0.streetName,
                    coordinates: try PolylineDecoder.decode($0.polyline.points, precision: $0.polyline.precision)
                )
            }
            let steps = try StreetGeometryValidator.normalizedSteps(
                decodedSteps, geometry: geometry,
                from: Coordinate(latitude: raw.from.lat, longitude: raw.from.lon),
                to: Coordinate(latitude: raw.to.lat, longitude: raw.to.lon)
            )
            let validated = try StreetGeometryValidator.validated(
                coordinates: geometry, steps: steps.map(\.coordinates),
                from: Coordinate(latitude: raw.from.lat, longitude: raw.from.lon),
                to: Coordinate(latitude: raw.to.lat, longitude: raw.to.lon),
                isWalk: raw.mode == "WALK", distance: raw.distance ?? 0,
                fromTransitStopID: from.transitStopID, toTransitStopID: to.transitStopID
            )
            let movement = MovementLeg(
                from: from,
                to: to,
                startTime: raw.startTime,
                endTime: raw.endTime,
                distance: raw.distance ?? 0,
                coordinates: validated,
                maneuvers: makeManeuvers(steps)
            )
            return raw.mode == "BIKE" ? .bike(movement) : .walk(movement)
        }

        return .transit(
            TransitLeg(
                from: from,
                to: to,
                startTime: raw.startTime,
                endTime: raw.endTime,
                mode: raw.mode,
                line: raw.routeShortName ?? raw.displayName ?? localizedMode(raw.mode),
                headsign: raw.headsign ?? raw.to.name,
                agency: raw.agencyName ?? "",
                departurePlatform: correctedPlatform(stopId: raw.from.stopId, rawPlatform: raw.from.track ?? raw.from.scheduledTrack),
                arrivalPlatform: correctedPlatform(stopId: raw.to.stopId, rawPlatform: raw.to.track ?? raw.to.scheduledTrack),
                isRealtime: raw.realTime ?? false,
                isCancelled: raw.cancelled ?? false,
                coordinates: geometry.isEmpty ? [from.coordinate, to.coordinate] : geometry,
                reference: TransitReference.make(
                    tripID: raw.tripId, fromID: raw.from.stopId, toID: raw.to.stopId,
                    departure: raw.scheduledStartTime, arrival: raw.scheduledEndTime
                ),
                lastUpdatedAt: Date()
            )
        )
    }

    private func makeManeuvers(_ rawSteps: [StreetGeometryValidator.Step]) -> [Maneuver] {
        var maneuvers: [Maneuver] = []
        for step in rawSteps {
            let direction = step.direction
            let coordinates = step.coordinates
            let street = step.streetName.trimmingCharacters(in: .whitespacesAndNewlines)
            if direction == .straight,
               let previous = maneuvers.last,
               previous.direction == .straight,
               previous.streetName == street {
                var mergedCoordinates = previous.coordinates
                if mergedCoordinates.last == coordinates.first {
                    mergedCoordinates.append(contentsOf: coordinates.dropFirst())
                } else {
                    mergedCoordinates.append(contentsOf: coordinates)
                }
                maneuvers[maneuvers.count - 1] = Maneuver(
                    id: previous.id,
                    direction: previous.direction,
                    instruction: previous.instruction,
                    streetName: previous.streetName,
                    distance: previous.distance + step.distance,
                    coordinates: mergedCoordinates
                )
                continue
            }
            maneuvers.append(
                Maneuver(
                    direction: direction,
                    instruction: instruction(for: direction, street: street),
                    streetName: street,
                    distance: step.distance,
                    coordinates: coordinates
                )
            )
        }
        return maneuvers
    }

    private func instruction(for direction: ManeuverDirection, street: String) -> String {
        let destination = street.isEmpty ? "" : " auf \(street)"
        switch direction {
        case .depart: return "Losfahren\(destination)"
        case .hardLeft: return "Scharf links\(destination)"
        case .left: return "Links abbiegen\(destination)"
        case .slightlyLeft: return "Leicht links\(destination)"
        case .straight: return "Geradeaus\(destination)"
        case .slightlyRight: return "Leicht rechts\(destination)"
        case .right: return "Rechts abbiegen\(destination)"
        case .hardRight: return "Scharf rechts\(destination)"
        case .circleClockwise, .circleCounterclockwise: return "In den Kreisverkehr fahren"
        case .stairs: return "Treppe nehmen"
        case .elevator: return "Aufzug nehmen"
        case .uTurnLeft, .uTurnRight: return "Wenden"
        }
    }

    private func mapPlace(_ raw: MOTISPlace, fallback: Place, endpointName: String) -> Place {
        if raw.name == endpointName {
            return Place(id: fallback.id, name: fallback.name, detail: fallback.detail,
                         coordinate: fallback.coordinate, transitStopID: raw.stopId ?? fallback.transitStopID)
        }
        let detail: String
        if let track = correctedPlatform(stopId: raw.stopId, rawPlatform: raw.track ?? raw.scheduledTrack) {
            detail = "Gleis \(track)"
        } else {
            detail = raw.description ?? ""
        }
        return Place(
            name: raw.name,
            detail: detail,
            coordinate: Coordinate(latitude: raw.lat, longitude: raw.lon),
            transitStopID: raw.stopId
        )
    }

    /// Documented DELFI GTFS platform_code bug (München only): the feed encodes some platforms
    /// with a wrong code. Keyed by stop_id (matched by suffix, since Transitous prefixes source
    /// feed ids e.g. "de-DELFI_"). See https://github.com/mfdz/GTFS-Issues/issues/238 (Pasing)
    /// and https://github.com/mfdz/GTFS-Issues/issues/230 (Berg am Laim, comment 2026-09-05).
    /// Deliberately does not cover #230's non-München stations — no single confirmed offset there.
    private static let delfiPlatformCorrectionsByStopId: [String: String] = [
        "de:09162:10:42:82": "2",
        "de:09162:10:43:83": "3",
        "de:09162:10:43:84": "4",
        "de:09162:10:45:85": "5",
        "de:09162:10:45:86": "6",
        "de:09162:10:47:87": "7",
        "de:09162:10:47:88": "8",
        "de:09162:10:49:89": "9",
        "de:09162:10:49:90": "10",
        "de:09162:910:41:82": "2"
    ]

    private func correctedPlatform(stopId: String?, rawPlatform: String?) -> String? {
        guard let stopId else { return rawPlatform }
        guard let match = Self.delfiPlatformCorrectionsByStopId.first(where: { stopId.hasSuffix($0.key) })
        else { return rawPlatform }
        // Correct only the documented encoded value. A real-time platform change
        // is already a display value and must not be overwritten by the old stop.
        guard rawPlatform == match.key.split(separator: ":").last.map(String.init) else { return rawPlatform }
        return match.value
    }

    private func localizedMode(_ mode: String) -> String {
        switch mode {
        case "SUBURBAN": "S-Bahn"
        case "SUBWAY": "U-Bahn"
        case "TRAM": "Tram"
        case "BUS": "Bus"
        case "REGIONAL_RAIL": "Regionalzug"
        case "LONG_DISTANCE", "HIGHSPEED_RAIL", "NIGHT_RAIL": "Fernzug"
        default: "ÖPNV"
        }
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            guard let date = standard.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 date")
            }
            return date
        }
        return decoder
    }
}

/// Evaluates the complete journey, including all access, wait and folding time.
enum TransitBenefitPolicy {
    static let minimumTimeSaving: TimeInterval = 180
    static let minimumDistanceSaving = 1_000.0
    static let minimumRelativeDistanceSaving = 0.2
    static let maximumExtraTime: TimeInterval = 600

    static func isWorthwhile(_ journey: Journey, comparedTo direct: Journey?, timing: RouteTiming) -> Bool {
        guard !journey.isDirect, let direct else { return true }
        let saving = timing.isArrival
            ? journey.departure.timeIntervalSince(direct.departure)
            : direct.arrival.timeIntervalSince(journey.arrival)
        if saving >= minimumTimeSaving { return true }
        let distanceSaving = direct.bikeDistance - journey.bikeDistance
        return saving >= -maximumExtraTime
            && distanceSaving >= minimumDistanceSaving
            && distanceSaving >= direct.bikeDistance * minimumRelativeDistanceSaving
    }
}

enum JourneyOptionSelector {
    static let maximumDisplayedOptions = 3
    static let minimumDirectBikeTolerance: TimeInterval = 10 * 60
    static let relativeDirectBikeTolerance = 0.2

    static func select(
        from journeys: [Journey],
        timing: RouteTiming,
        maximumOptions: Int = maximumDisplayedOptions
    ) -> [Journey] {
        guard maximumOptions > 0 else { return [] }

        let direct = journeys.filter { $0.isDirect }.sorted { comesBefore($0, $1, timing: timing) }.first
        let worthwhile = journeys.filter { TransitBenefitPolicy.isWorthwhile($0, comparedTo: direct, timing: timing) }
        let eligible = worthwhile.filter { journey in
            guard journey.isDirect,
                  let bestTransit = bestTransitJourney(in: worthwhile, timing: timing) else {
                return true
            }
            let tolerance = max(
                minimumDirectBikeTolerance,
                bestTransit.duration * relativeDirectBikeTolerance
            )
            return primaryDisadvantage(
                of: journey,
                comparedTo: bestTransit,
                timing: timing
            ) <= tolerance
        }
        var seen: Set<String> = []
        let ranked = eligible.sorted { comesBefore($0, $1, timing: timing) }.filter {
            seen.insert(connectionKey($0)).inserted
        }
        guard ranked.count >= maximumOptions else { return ranked }

        var selectedIndices: [Int] = []
        var signatures: Set<RouteSignature> = []
        for (index, journey) in ranked.enumerated() {
            if signatures.insert(RouteSignature(journey)).inserted {
                selectedIndices.append(index)
            }
            if selectedIndices.count == maximumOptions { break }
        }

        if selectedIndices.count < maximumOptions {
            for index in ranked.indices where !selectedIndices.contains(index) {
                selectedIndices.append(index)
                if selectedIndices.count == maximumOptions { break }
            }
        }

        return selectedIndices.map { ranked[$0] }
    }

    private static func bestTransitJourney(
        in journeys: [Journey],
        timing: RouteTiming
    ) -> Journey? {
        journeys
            .filter { !$0.isDirect }
            .sorted { comesBefore($0, $1, timing: timing) }
            .first
    }

    private static func primaryDisadvantage(
        of journey: Journey,
        comparedTo reference: Journey,
        timing: RouteTiming
    ) -> TimeInterval {
        if timing.isArrival {
            return reference.departure.timeIntervalSince(journey.departure)
        }
        return journey.arrival.timeIntervalSince(reference.arrival)
    }

    private static func comesBefore(
        _ lhs: Journey,
        _ rhs: Journey,
        timing: RouteTiming
    ) -> Bool {
        if timing.isArrival, lhs.departure != rhs.departure {
            return lhs.departure > rhs.departure
        }
        if !timing.isArrival, lhs.arrival != rhs.arrival {
            return lhs.arrival < rhs.arrival
        }
        if lhs.transfers != rhs.transfers { return lhs.transfers < rhs.transfers }
        let leftRides = lhs.legs.filter { $0.kind == .bike || $0.kind == .approach }.count
        let rightRides = rhs.legs.filter { $0.kind == .bike || $0.kind == .approach }.count
        if leftRides != rightRides { return leftRides < rightRides }
        if lhs.bikeDistance != rhs.bikeDistance { return lhs.bikeDistance < rhs.bikeDistance }
        if lhs.walkingDistance != rhs.walkingDistance { return lhs.walkingDistance < rhs.walkingDistance }
        return lhs.id < rhs.id
    }

    private static func connectionKey(_ journey: Journey) -> String {
        if journey.isDirect { return "direct|\(journey.id)" }
        let transit = journey.legs.compactMap { leg -> TransitLeg? in
            if case .transit(let transit) = leg { return transit }
            return nil
        }
        guard !transit.isEmpty else { return journey.id }
        return transit.map { leg in
            if let reference = leg.reference {
                // A provider may reuse a timetable trip ID on another operating day.
                let day = Int(floor(reference.scheduledDeparture.timeIntervalSince1970 / 86_400))
                return "trip|\(reference.tripID)|\(day)"
            }
            return "fallback|\(leg.mode)|\(leg.line)|\(leg.from.coordinate)|\(leg.to.coordinate)|\(leg.startTime.timeIntervalSince1970)|\(leg.endTime.timeIntervalSince1970)"
        }.joined(separator: ";")
    }

    private struct RouteSignature: Hashable {
        let isDirect: Bool
        let transitLegs: [TransitSignature]
        let bikeConnections: [String]

        init(_ journey: Journey) {
            isDirect = journey.isDirect
            bikeConnections = journey.bikeTransferBoardings.sorted().map { index in
                let previous = journey.legs[..<index].lastIndex { $0.kind == .transit }!
                return journey.legs[(previous + 1)..<index].filter { $0.kind == .bike }
                    .map { "\($0.startPlace.coordinate)|\($0.endPlace.coordinate)" }.joined(separator: ";")
            }
            transitLegs = journey.legs.compactMap { leg in
                guard case .transit(let transit) = leg else { return nil }
                return TransitSignature(
                    mode: transit.mode,
                    line: transit.line,
                    headsign: transit.headsign,
                    from: transit.from.name,
                    to: transit.to.name
                )
            }
        }
    }

    private struct TransitSignature: Hashable {
        let mode: String
        let line: String
        let headsign: String
        let from: String
        let to: String
    }
}

private extension Result where Success == [Journey], Failure == RoutePlannerError {
    var valueOrEmpty: [Journey] {
        if case .success(let value) = self { return value }
        return []
    }

    var failure: RoutePlannerError? {
        if case .failure(let error) = self { return error }
        return nil
    }
}

private struct MOTISPlanResponse: Decodable, Sendable {
    let itineraries: [MOTISItinerary]
    let direct: [MOTISItinerary]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        itineraries = try container.decodeIfPresent([MOTISItinerary].self, forKey: .itineraries) ?? []
        direct = try container.decodeIfPresent([MOTISItinerary].self, forKey: .direct) ?? []
    }

    private enum CodingKeys: String, CodingKey { case itineraries, direct }
}

private struct MOTISItinerary: Decodable, Sendable {
    let id: String
    let startTime: Date
    let endTime: Date
    let duration: Int
    let transfers: Int
    let legs: [MOTISLeg]
}

private struct MOTISLeg: Decodable, Sendable {
    let mode: String
    let from: MOTISPlace
    let to: MOTISPlace
    let startTime: Date
    let endTime: Date
    let distance: Double?
    let routeShortName: String?
    let displayName: String?
    let headsign: String?
    let agencyName: String?
    let tripId: String?
    let scheduledStartTime: Date?
    let scheduledEndTime: Date?
    let realTime: Bool?
    let cancelled: Bool?
    let legGeometry: MOTISPolyline?
    let steps: [MOTISStep]?
}

private struct MOTISPlace: Decodable, Sendable {
    let name: String
    let lat: Double
    let lon: Double
    let stopId: String?
    let track: String?
    let scheduledTrack: String?
    let description: String?
}

private struct MOTISPolyline: Decodable, Sendable {
    let points: String
    let precision: Int
}

private struct MOTISStep: Decodable, Sendable {
    let relativeDirection: String
    let distance: Double
    let polyline: MOTISPolyline
    let streetName: String
}
