import CoreLocation
import Foundation

struct Coordinate: Codable, Hashable, Sendable {
    let latitude: Double
    let longitude: Double

    init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    init(_ coordinate: CLLocationCoordinate2D) {
        self.init(latitude: coordinate.latitude, longitude: coordinate.longitude)
    }

    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    func distance(to other: Coordinate) -> CLLocationDistance {
        CLLocation(latitude: latitude, longitude: longitude)
            .distance(from: CLLocation(latitude: other.latitude, longitude: other.longitude))
    }
}

struct Place: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let name: String
    let detail: String
    let coordinate: Coordinate
    let transitStopID: String?

    init(id: UUID = UUID(), name: String, detail: String = "", coordinate: Coordinate, transitStopID: String? = nil) {
        self.id = id
        self.name = name
        self.detail = detail
        self.coordinate = coordinate
        let normalizedID = transitStopID?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.transitStopID = normalizedID?.isEmpty == false ? normalizedID : nil
    }

    static let munichCenter = Place(
        name: "München",
        detail: "Stadtzentrum",
        coordinate: Coordinate(latitude: 48.1372, longitude: 11.5756)
    )
}

enum RouteTiming: Codable, Hashable, Sendable {
    case leaveNow
    case departAt(Date)
    case arriveBy(Date)

    var date: Date {
        switch self {
        case .leaveNow: Date()
        case .departAt(let date), .arriveBy(let date): date
        }
    }

    var isArrival: Bool {
        if case .arriveBy = self { return true }
        return false
    }
}

struct RouteRequest: Codable, Hashable, Sendable {
    let origin: Place
    let destination: Place
    let timing: RouteTiming
}

enum TransitModePreference: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case suburbanRail
    case subway
    case tram
    case bus
    case regionalRail
    case longDistanceRail

    var id: Self { self }

    var title: String {
        switch self {
        case .suburbanRail: "S-Bahn"
        case .subway: "U-Bahn"
        case .tram: "Tram"
        case .bus: "Bus"
        case .regionalRail: "Regionalzüge"
        case .longDistanceRail: "Fernzüge"
        }
    }

    var motisModes: [String] {
        switch self {
        case .suburbanRail: ["SUBURBAN"]
        case .subway: ["SUBWAY"]
        case .tram: ["TRAM"]
        case .bus: ["BUS", "COACH"]
        case .regionalRail: ["REGIONAL_RAIL"]
        case .longDistanceRail: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"]
        }
    }
}

struct NavigationSettings: Codable, Hashable, Sendable {
    static let cyclingSpeedRange: ClosedRange<Double> = 10...30

    static let foldingDurationRange: ClosedRange<Double> = 60...600
    var foldingDuration: TimeInterval = 180
    var foldDuration: TimeInterval { foldingDuration }
    var unfoldDuration: TimeInterval { foldingDuration }

    var foldingDurationLabel: String {
        let seconds = Int(foldingDuration.rounded())
        let minutes = seconds / 60
        let remainder = seconds % 60
        return remainder == 0 ? "\(minutes) Min." : "\(minutes) Min. \(remainder) Sek."
    }

    static func migratedFoldingDuration(_ values: [TimeInterval]) -> TimeInterval {
        let duration = values.filter(\.isFinite).max() ?? 180
        return min(foldingDurationRange.upperBound, max(foldingDurationRange.lowerBound, duration))
    }
    var cyclingSpeedKilometersPerHour = 15.0
    var audioEnabled = true
    var hapticsEnabled = true
    var excludedTransitModes: Set<TransitModePreference> = []
    var maxCyclingAccessMinutes = 30
    var maxWalkingMinutes = 2
    var maxBikeTransfers = 2
    var maxBikeTransferMinutes = 15

    struct RoutingConfiguration: Equatable {
        let cyclingSpeed: Double
        let cyclingAccessMinutes: Int
        let walkingMinutes: Int
        let foldingDuration: TimeInterval
        let excludedModes: Set<TransitModePreference>
        let bikeTransfers: Int
        let bikeTransferMinutes: Int
    }

    var routingConfiguration: RoutingConfiguration {
        RoutingConfiguration(cyclingSpeed: cyclingSpeedKilometersPerHour,
            cyclingAccessMinutes: maxCyclingAccessMinutes,
            walkingMinutes: maxWalkingMinutes, foldingDuration: foldingDuration,
            excludedModes: excludedTransitModes, bikeTransfers: maxBikeTransfers,
            bikeTransferMinutes: maxBikeTransferMinutes)
    }

    static let defaults = NavigationSettings()

    var cyclingSpeedMetersPerSecond: Double {
        cyclingSpeedKilometersPerHour / 3.6
    }

    var allowedTransitModes: [String] {
        TransitModePreference.allCases
            .filter { !excludedTransitModes.contains($0) }
            .flatMap(\.motisModes)
    }

    func isTransitModeEnabled(_ mode: TransitModePreference) -> Bool {
        !excludedTransitModes.contains(mode)
    }

    mutating func setTransitMode(_ mode: TransitModePreference, enabled: Bool) {
        if enabled {
            excludedTransitModes.remove(mode)
        } else {
            excludedTransitModes.insert(mode)
        }
    }
}

enum JourneyLegKind: String, Codable, CaseIterable, Sendable {
    case approach
    case bike
    case fold
    case walk
    case transit
    case unfold
    case wait

    var title: String {
        switch self {
        case .approach: "Zum Start"
        case .bike: "Rad"
        case .fold: "Falten"
        case .walk: "Zu Fuß"
        case .transit: "ÖPNV"
        case .unfold: "Entfalten"
        case .wait: "Warten"
        }
    }
}

enum ManeuverDirection: String, Codable, Hashable, Sendable {
    case depart = "DEPART"
    case hardLeft = "HARD_LEFT"
    case left = "LEFT"
    case slightlyLeft = "SLIGHTLY_LEFT"
    case straight = "CONTINUE"
    case slightlyRight = "SLIGHTLY_RIGHT"
    case right = "RIGHT"
    case hardRight = "HARD_RIGHT"
    case circleClockwise = "CIRCLE_CLOCKWISE"
    case circleCounterclockwise = "CIRCLE_COUNTERCLOCKWISE"
    case stairs = "STAIRS"
    case elevator = "ELEVATOR"
    case uTurnLeft = "UTURN_LEFT"
    case uTurnRight = "UTURN_RIGHT"

    var symbol: String {
        switch self {
        case .depart, .straight: "arrow.up"
        case .hardLeft, .left: "arrow.turn.up.left"
        case .slightlyLeft: "arrow.up.left"
        case .slightlyRight: "arrow.up.right"
        case .hardRight, .right: "arrow.turn.up.right"
        case .circleClockwise, .circleCounterclockwise: "arrow.trianglehead.2.clockwise.rotate.90"
        case .stairs: "figure.stairs"
        case .elevator: "elevator"
        case .uTurnLeft: "arrow.uturn.left"
        case .uTurnRight: "arrow.uturn.right"
        }
    }
}

struct Maneuver: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let direction: ManeuverDirection
    let instruction: String
    let streetName: String
    let distance: Double
    let coordinates: [Coordinate]

    init(
        id: UUID = UUID(),
        direction: ManeuverDirection,
        instruction: String,
        streetName: String,
        distance: Double,
        coordinates: [Coordinate]
    ) {
        self.id = id
        self.direction = direction
        self.instruction = instruction
        self.streetName = streetName
        self.distance = distance
        self.coordinates = coordinates
    }

    var endpoint: Coordinate? { coordinates.last }
}

struct MovementLeg: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let from: Place
    let to: Place
    let startTime: Date
    let endTime: Date
    let distance: Double
    let coordinates: [Coordinate]
    let maneuvers: [Maneuver]

    init(
        id: UUID = UUID(),
        from: Place,
        to: Place,
        startTime: Date,
        endTime: Date,
        distance: Double,
        coordinates: [Coordinate],
        maneuvers: [Maneuver]
    ) {
        self.id = id
        self.from = from
        self.to = to
        self.startTime = startTime
        self.endTime = endTime
        self.distance = distance
        self.coordinates = coordinates
        self.maneuvers = maneuvers
    }

    func shifted(by interval: TimeInterval) -> MovementLeg {
        MovementLeg(
            id: id,
            from: from,
            to: to,
            startTime: startTime.addingTimeInterval(interval),
            endTime: endTime.addingTimeInterval(interval),
            distance: distance,
            coordinates: coordinates,
            maneuvers: maneuvers
        )
    }
}

struct TransitLeg: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let from: Place
    let to: Place
    var startTime: Date
    var endTime: Date
    let mode: String
    let line: String
    let headsign: String
    let agency: String
    var departurePlatform: String?
    var arrivalPlatform: String?
    var isRealtime: Bool
    var isCancelled: Bool
    let coordinates: [Coordinate]
    var reference: TransitReference?
    var lastUpdatedAt: Date?
    var refreshFailure: TransitRefreshFailure?

    init(
        id: UUID = UUID(),
        from: Place,
        to: Place,
        startTime: Date,
        endTime: Date,
        mode: String,
        line: String,
        headsign: String,
        agency: String,
        departurePlatform: String?,
        arrivalPlatform: String?,
        isRealtime: Bool,
        isCancelled: Bool,
        coordinates: [Coordinate],
        reference: TransitReference? = nil,
        lastUpdatedAt: Date? = nil
    ) {
        self.id = id
        self.from = from
        self.to = to
        self.startTime = startTime
        self.endTime = endTime
        self.mode = mode
        self.line = line
        self.headsign = headsign
        self.agency = agency
        self.departurePlatform = departurePlatform
        self.arrivalPlatform = arrivalPlatform
        self.isRealtime = isRealtime
        self.isCancelled = isCancelled
        self.coordinates = coordinates
        self.reference = reference
        self.lastUpdatedAt = lastUpdatedAt
    }
}

struct TransitionLeg: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let place: Place
    let startTime: Date
    let endTime: Date

    init(id: UUID = UUID(), place: Place, startTime: Date, endTime: Date) {
        self.id = id
        self.place = place
        self.startTime = startTime
        self.endTime = endTime
    }
}

enum JourneyLeg: Codable, Hashable, Identifiable, Sendable {
    case approach(MovementLeg)
    case bike(MovementLeg)
    case fold(TransitionLeg)
    case walk(MovementLeg)
    case transit(TransitLeg)
    case unfold(TransitionLeg)
    case wait(TransitionLeg)

    var id: UUID {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.id
        case .fold(let leg), .unfold(let leg), .wait(let leg): leg.id
        case .transit(let leg): leg.id
        }
    }

    var kind: JourneyLegKind {
        switch self {
        case .approach: .approach
        case .bike: .bike
        case .fold: .fold
        case .walk: .walk
        case .transit: .transit
        case .unfold: .unfold
        case .wait: .wait
        }
    }

    var startTime: Date {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.startTime
        case .fold(let leg), .unfold(let leg), .wait(let leg): leg.startTime
        case .transit(let leg): leg.startTime
        }
    }

    var endTime: Date {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.endTime
        case .fold(let leg), .unfold(let leg), .wait(let leg): leg.endTime
        case .transit(let leg): leg.endTime
        }
    }

    var coordinates: [Coordinate] {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.coordinates
        case .fold(let leg), .unfold(let leg), .wait(let leg): [leg.place.coordinate]
        case .transit(let leg): leg.coordinates
        }
    }

    var startPlace: Place {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.from
        case .fold(let leg), .unfold(let leg), .wait(let leg): leg.place
        case .transit(let leg): leg.from
        }
    }

    var endPlace: Place {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.to
        case .fold(let leg), .unfold(let leg), .wait(let leg): leg.place
        case .transit(let leg): leg.to
        }
    }

    var distance: Double {
        switch self {
        case .approach(let leg), .bike(let leg), .walk(let leg): leg.distance
        default: 0
        }
    }

    func shifted(by interval: TimeInterval) -> JourneyLeg {
        switch self {
        case .approach(let leg): .approach(leg.shifted(by: interval))
        case .bike(let leg): .bike(leg.shifted(by: interval))
        case .walk(let leg): .walk(leg.shifted(by: interval))
        case .transit, .fold, .unfold, .wait: self
        }
    }
}

struct Journey: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let origin: Place
    let destination: Place
    let waypoint: Place?
    let departure: Date
    let arrival: Date
    let legs: [JourneyLeg]
    let transfers: Int
    let isDirect: Bool
    let score: Double

    init(
        id: String,
        origin: Place,
        destination: Place,
        waypoint: Place? = nil,
        departure: Date,
        arrival: Date,
        legs: [JourneyLeg],
        transfers: Int,
        isDirect: Bool,
        score: Double
    ) {
        self.id = id
        self.origin = origin
        self.destination = destination
        self.waypoint = waypoint
        self.departure = departure
        self.arrival = arrival
        self.legs = legs
        self.transfers = transfers
        self.isDirect = isDirect
        self.score = score
    }

    var duration: TimeInterval { arrival.timeIntervalSince(departure) }
    var bikeDistance: Double {
        legs.filter { $0.kind == .bike || $0.kind == .approach }.reduce(0) { $0 + $1.distance }
    }
    var walkingDistance: Double { legs.filter { $0.kind == .walk }.reduce(0) { $0 + $1.distance } }
}

enum NavigationStartDecision: Equatable, Sendable {
    case start
    case approach(distance: CLLocationDistance)
    case tooFar(distance: CLLocationDistance)
    case unavailable
}

enum NavigationStartPolicy {
    static let normalStartDistance: CLLocationDistance = 250
    static let maximumApproachDistance: CLLocationDistance = 25_000
    static let maximumLocationAge: TimeInterval = 60
    static let maximumHorizontalAccuracy: CLLocationAccuracy = 100

    static func decision(
        location: CLLocation?,
        origin: Coordinate,
        now: Date = Date()
    ) -> NavigationStartDecision {
        guard let location, isUsable(location, now: now) else {
            return .unavailable
        }

        let distance = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
            .distance(from: location)
        if distance < normalStartDistance { return .start }
        if distance <= maximumApproachDistance { return .approach(distance: distance) }
        return .tooFar(distance: distance)
    }

    static func isUsable(_ location: CLLocation, now: Date = Date()) -> Bool {
        location.horizontalAccuracy >= 0
            && location.horizontalAccuracy <= maximumHorizontalAccuracy
            && abs(now.timeIntervalSince(location.timestamp)) <= maximumLocationAge
    }
}

enum ApproachJourneyComposer {
    static let connectionBuffer: TimeInterval = 60

    static func canKeepConnection(approachArrival: Date, onwardDeparture: Date) -> Bool {
        approachArrival.addingTimeInterval(connectionBuffer) <= onwardDeparture
    }

    static func compose(approach: Journey, onward: Journey, waypoint: Place) throws -> Journey {
        guard canKeepConnection(
            approachArrival: approach.arrival,
            onwardDeparture: onward.departure
        ) else {
            throw RoutePlannerError.invalidResponse
        }
        let approachLegs = try approach.legs.map { leg -> JourneyLeg in
            switch leg {
            case .approach(let movement), .bike(let movement):
                return .approach(movement)
            default:
                throw RoutePlannerError.invalidResponse
            }
        }

        var legs = approachLegs
        if onward.departure > approach.arrival {
            legs.append(
                .wait(
                    TransitionLeg(
                        place: waypoint,
                        startTime: approach.arrival,
                        endTime: onward.departure
                    )
                )
            )
        }
        legs.append(contentsOf: onward.legs)

        return Journey(
            id: "approach:\(approach.id)|\(onward.id)",
            origin: approach.origin,
            destination: onward.destination,
            waypoint: waypoint,
            departure: approach.departure,
            arrival: onward.arrival,
            legs: legs,
            transfers: onward.transfers,
            isDirect: false,
            score: onward.score
        )
    }

    static func onwardJourney(from journey: Journey) -> Journey? {
        guard let waypoint = journey.waypoint else { return nil }
        let legs = Array(journey.legs.drop(while: { $0.kind == .approach || $0.kind == .wait }))
        guard let departure = legs.first?.startTime, let arrival = legs.last?.endTime else { return nil }
        return Journey(
            id: "onward:\(journey.id)",
            origin: waypoint,
            destination: journey.destination,
            departure: departure,
            arrival: arrival,
            legs: legs,
            transfers: journey.transfers,
            isDirect: !legs.contains(where: { $0.kind == .transit }),
            score: journey.score
        )
    }
}

enum NavigationPhase: Equatable, Sendable {
    case idle
    case active(legIndex: Int, maneuverIndex: Int)
    case arrived
}

protocol JourneyPlanning: Sendable {
    func alternativeUpdates(_ request: RouteRequest, settings: NavigationSettings) -> AsyncThrowingStream<JourneyOptionsUpdate, Error>
    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey
    func planAlternatives(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> [Journey]
    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey
}

extension JourneyPlanning {
    func alternativeUpdates(_ request: RouteRequest, settings: NavigationSettings) -> AsyncThrowingStream<JourneyOptionsUpdate, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let options = try await planAlternatives(request, settings: settings)
                    try Task.checkCancellation()
                    continuation.yield(JourneyOptionsUpdate(journeys: options, status: .complete))
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
    func planAlternatives(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> [Journey] {
        [try await plan(request, settings: settings)]
    }
}

indirect enum RoutePlannerError: LocalizedError, Equatable, Sendable {
    case placesTooClose
    case offline
    case noRoute
    case rateLimited
    case invalidResponse
    case invalidRouteGeometry
    case serviceUnavailable
    case timedOut
    case searchDeadline
    case localFailure
    case storageFailure
    case serverPause(Date)
    case multiple([RoutePlannerError])

    var errorDescription: String? {
        switch self {
        case .placesTooClose: "Start und Ziel liegen zu nah beieinander."
        case .offline: "Keine Internetverbindung. Bitte Verbindung prüfen."
        case .noRoute: "Keine passende Route gefunden. Ändere Ziel oder Zeit."
        case .rateLimited: "Zu viele Anfragen beim Routingdienst. Bitte später erneut versuchen."
        case .invalidResponse: "Die Antwort des Routingdienstes konnte nicht verarbeitet werden."
        case .invalidRouteGeometry: "Keine Verbindung mit gültigen Streckendaten erhalten."
        case .timedOut: "Der Routingdienst hat nicht rechtzeitig geantwortet."
        case .searchDeadline: "Die Suche nach weiteren Verbindungen wurde wegen Zeitüberschreitung beendet."
        case .storageFailure: "Route konnte nicht gespeichert werden."
        case .localFailure: "Die Routen konnten nicht vollständig verarbeitet werden."
        case .serverPause: "Der Routingdienst bittet um eine Pause. Bitte später erneut versuchen."
        case .multiple(let issues): Self.unique(issues).map { $0.localizedDescription }.joined(separator: "\n")
        case .serviceUnavailable: "Der Routingdienst ist vorübergehend nicht verfügbar."
        }
    }
}

/// Uses the original requested start, never the time at which a view renders.
enum LateDeparturePolicy {
    static func delay(departure: Date, timing: RouteTiming?) -> TimeInterval? {
        guard case .departAt(let requested) = timing else { return nil }
        let delay = departure.timeIntervalSince(requested)
        return delay >= 3600 ? delay : nil
    }
}


extension RoutePlannerError {
    static func classify(_ error: Error) -> RoutePlannerError {
        if let error = error as? RoutePlannerError { return error }
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost: return .offline
            case .timedOut: return .timedOut
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: return .serviceUnavailable
            default: return .localFailure
            }
        }
        return .localFailure
    }

    static func unique(_ issues: [RoutePlannerError]) -> [RoutePlannerError] {
        var result: [RoutePlannerError] = []
        for issue in issues {
            let items: [RoutePlannerError]
            if case .multiple(let nested) = issue { items = unique(nested) } else { items = [issue] }
            for item in items where !result.contains(item) {
                if case .serverPause(let deadline) = item {
                    let latest = result.compactMap { issue -> Date? in
                        if case .serverPause(let date) = issue { return date }
                        return nil
                    }.max()
                    result.removeAll { if case .serverPause = $0 { true } else { false } }
                    result.append(.serverPause(max(latest ?? deadline, deadline)))
                } else { result.append(item) }
            }
        }
        return result.filter(\.stopsRequests) + result.filter { !$0.stopsRequests }
    }

    var stopsRequests: Bool {
        switch self {
        case .rateLimited, .serverPause: true
        case .multiple(let issues): issues.contains(where: \.stopsRequests)
        default: false
        }
    }

    var partialDescription: String {
        self == .invalidRouteGeometry
            ? "Einige Verbindungen wurden wegen fehlerhafter Streckendaten ausgeblendet."
            : localizedDescription
    }
}

/// Shared by client copies, and by production clients throughout this app run.
/// Inject a separate instance in tests. Never delays or automatically retries a request.
final class PlanningServerPause: @unchecked Sendable {
    static let shared = PlanningServerPause()
    private let lock = NSLock()
    private var deadline: Date?

    var retryAt: Date? { lock.withLock { deadline } }

    func record(retryAt: Date) {
        lock.withLock { deadline = max(deadline ?? retryAt, retryAt) }
    }

    func check(now: Date = Date()) throws {
        if let deadline = retryAt, deadline > now { throw RoutePlannerError.serverPause(deadline) }
    }
}
