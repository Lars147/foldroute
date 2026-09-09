import CoreLocation
import Foundation
import MapKit
import Observation

enum TimingSelection: String, CaseIterable, Identifiable {
    case now
    case depart
    case arrive

    var id: Self { self }

    var title: String {
        switch self {
        case .now: "Jetzt"
        case .depart: "Abfahrt"
        case .arrive: "Ankunft"
        }
    }
}

enum SearchTarget: String, Identifiable {
    case origin
    case destination
    case stop

    var id: Self { self }
    var title: String { self == .origin ? "Start wählen" : self == .stop ? "Zwischenziel wählen" : "Ziel wählen" }
}

enum PlanningState: Equatable {
    case idle
    case locating
    case loading
    case ready
    case failed(String)

    var isLoading: Bool { self == .locating || self == .loading }
}

enum NavigationStartState: Equatable {
    case idle
    case locating
    case preparingApproach
    case distantStart(distance: CLLocationDistance)
    case failed(String)

    var isLoading: Bool {
        self == .locating || self == .preparingApproach
    }
}

enum HistoryPlaceNameFormatter {
    static func displayName(neighborhood: String?, city: String?) -> String? {
        let neighborhood = normalized(neighborhood)
        let city = normalized(city)
        if let neighborhood,
           neighborhood.localizedCaseInsensitiveCompare(city ?? "") != .orderedSame {
            return neighborhood
        }
        return city
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

@MainActor
protocol HistoryPlaceNameResolving {
    func displayName(for coordinate: Coordinate) async throws -> String?
}

@MainActor
struct MapKitHistoryPlaceNameResolver: HistoryPlaceNameResolving {
    func displayName(for coordinate: Coordinate) async throws -> String? {
        let location = CLLocation(
            latitude: coordinate.latitude,
            longitude: coordinate.longitude
        )

        if #available(iOS 26.0, *) {
            guard let request = MKReverseGeocodingRequest(location: location) else { return nil }
            request.preferredLocale = Locale(identifier: "de_DE")
            guard let mapItem = try await request.mapItems.first else { return nil }
            return HistoryPlaceNameFormatter.displayName(
                neighborhood: mapItem.placemark.subLocality,
                city: mapItem.addressRepresentations?.cityName
                    ?? mapItem.placemark.locality
            )
        }

        let placemark = try await CLGeocoder().reverseGeocodeLocation(
            location,
            preferredLocale: Locale(identifier: "de_DE")
        ).first
        return HistoryPlaceNameFormatter.displayName(
            neighborhood: placemark?.subLocality,
            city: placemark?.locality
        )
    }
}

@MainActor
@Observable
final class AppModel {
    private let planner: any JourneyPlanning
    private let store: any JourneyStore
    private let transitRefresher: any TransitRefreshing
    private let historyPlaceNameResolver: any HistoryPlaceNameResolving
    private let planningLocationProvider: (@MainActor () async -> CLLocation?)?
    let location: LocationService
    let guidance: GuidanceService

    var origin: Place?
    var destination: Place?
    var timingSelection: TimingSelection = .now
    var plannedDate = Date().addingTimeInterval(30 * 60)
    var planningState: PlanningState = .idle
    var navigationStartState: NavigationStartState = .idle
    var routeStops: [RouteStop] = []
    var journey: Journey? { didSet { if let journey { routeStops = journey.stops } } }
    var journeyOptions: [Journey] = []
    private(set) var previewTiming: RouteTiming?

    func lateDepartureDelay(for journey: Journey) -> TimeInterval? {
        guard navigation == nil, planningState == .ready,
              !isReplanningAfterNavigation, bikeTransferSearchStatus != .searching else { return nil }
        return LateDeparturePolicy.delay(departure: journey.departure, timing: previewTiming)
    }

    var navigation: NavigationEngine?
    var settings: NavigationSettings {
        didSet {
            if oldValue.routingConfiguration != settings.routingConfiguration {
                invalidateRouteForSettings()
            }
        }
    }
    private var previewReplanTask: Task<Void, Never>?
    private var settingsReplanPending = false
    private(set) var isPreviewReplan = false
    private var routingProducerTask: Task<Void, Never>?
    var dataMessage: String?

    private var navigationClock: Task<Void, Never>?
    private var navigationAlerts: Task<Void, Never>?
    private var hasRecordedArrival = false
    private var planningGeneration = 0
    private var navigationGeneration = 0
    private var transitRefreshTask: Task<Void, Never>?
    private var transitRefreshToken: UUID?
    private var transitDue: [UUID: Date] = [:]
    private var transitFailures: [UUID: Int] = [:]
    private var transitRateLimitedUntil: Date?
    private var alternativeTask: Task<Void, Never>?
    private var lastAlternativeIssueID: String?
    var transitDisruption: TransitDisruption?
    var navigationAlternative: NavigationAlternative?
    var alternativeMessage: String?
    var isFindingAlternative = false
    private var returnPlanningTask: Task<Void, Never>?
    var isReplanningAfterNavigation = false
    private var bikeTransferTask: Task<Void, Never>?
    private var bikeTransferToken: UUID?
    private var explicitlySelectedJourneyID: String?
    var planningIssues: [RoutePlannerError] = []
    private var pauseClock = Date()
    private var serverPause: PlanningServerPause { (planner as? TransitousClient)?.planningPause ?? .shared }
    var planningPauseMessage: String? {
        _ = pauseClock
        guard let deadline = serverPause.retryAt, deadline > Date() else { return nil }
        let seconds = max(1, Int(ceil(deadline.timeIntervalSinceNow)))
        return "Der Routingdienst bittet um eine Pause. Erneut versuchen in \(seconds / 60):\(String(format: "%02d", seconds % 60)) Min."
    }
    var planningRequestsPaused: Bool { planningPauseMessage != nil }
    func planningFailureMessage(_ fallback: String) -> String {
        if let pause = planningPauseMessage { return pause }
        let genericPause = RoutePlannerError.serverPause(.distantPast).localizedDescription
        let remaining = fallback.components(separatedBy: "\n").filter { $0 != genericPause }
        return remaining.isEmpty ? "Die Serverpause ist beendet. Du kannst erneut versuchen." : remaining.joined(separator: "\n")
    }

    var planningNotice: String? {
        var messages = RoutePlannerError.unique(planningIssues).compactMap { issue -> String? in
            if case .serverPause = issue { return nil }
            return issue.partialDescription
        }
        if let pause = planningPauseMessage { messages.insert(pause, at: 0) }
        guard !messages.isEmpty else { return nil }
        return (messages + ["Bereits gefundene Routen bleiben verfügbar."]).joined(separator: "\n")
    }

    @discardableResult
    private func blockPausedPlanning() -> Bool {
        guard planningPauseMessage != nil else { return false }
        if journey == nil || isPreviewReplan || isReplanningAfterNavigation { planningState = .failed(RoutePlannerError.serverPause(serverPause.retryAt!).localizedDescription) }
        return true
    }

    var bikeTransferSearchStatus: BikeTransferSearchStatus = .complete

    init(
        planner: any JourneyPlanning,
        store: any JourneyStore,
        location: LocationService,
        guidance: GuidanceService,
        historyPlaceNameResolver: any HistoryPlaceNameResolving = MapKitHistoryPlaceNameResolver(),
        planningLocationProvider: (@MainActor () async -> CLLocation?)? = nil,
        transitRefresher: (any TransitRefreshing)? = nil
    ) throws {
        self.planner = planner
        self.store = store
        self.transitRefresher = transitRefresher ?? (planner as? any TransitRefreshing) ?? UnavailableTransitRefresher()
        self.location = location
        self.guidance = guidance
        self.historyPlaceNameResolver = historyPlaceNameResolver
        self.planningLocationProvider = planningLocationProvider
        settings = try store.loadSettings()
        location.onLocation = { [weak self] location in
            self?.handle(location)
        }
        if let snapshot = try store.loadActiveSnapshot(),
           let progress = snapshot.progress,
           progress.isValid(for: snapshot.journey),
           (try? StreetGeometryValidator.validate(snapshot.journey, startingAt: progress.legIndex)) != nil {
            journey = snapshot.journey
            routeStops = snapshot.journey.stops
            origin = snapshot.journey.origin
            destination = snapshot.journey.destination
            journeyOptions = [snapshot.journey]
            planningState = .ready
            try activateNavigation(with: snapshot.journey, startLocationUpdates: true, progress: progress)
        } else {
            try store.clearActiveJourney()
            guidance.cancelAlerts()
        }
        Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard let self else { return }
                if serverPause.retryAt != nil { pauseClock = Date() }
            }
        }
    }

    var canPlan: Bool { origin != nil && destination != nil && !planningState.isLoading && !planningRequestsPaused }

    var selectedJourneyIndex: Int {
        guard let journey else { return 0 }
        return journeyOptions.firstIndex { $0.id == journey.id } ?? 0
    }

    var routeTiming: RouteTiming {
        switch timingSelection {
        case .now: .leaveNow
        case .depart: .departAt(plannedDate)
        case .arrive: .arriveBy(plannedDate)
        }
    }

    func requestLocation() {
        location.requestAuthorization()
        location.requestSingleUpdate()
        useCurrentLocationIfAvailable()
    }

    func useCurrentLocationIfAvailable() {
        guard let current = location.currentLocation else { return }
        origin = Place(
            name: "Aktueller Standort",
            detail: location.hasPreciseLocation ? "Genauer Standort" : "Ungefährer Standort",
            coordinate: Coordinate(current.coordinate)
        )
    }

    func setFavorite(_ place: Place, isFavorite: Bool) throws {
        try store.setFavorite(place, isFavorite: isFavorite)
    }

    func select(_ place: Place, for target: SearchTarget) {
        switch target {
        case .origin: origin = place
        case .destination: destination = place
        case .stop: break
        }

        guard place.name != "Aktueller Standort" else { return }
        do {
            try store.saveRecentPlace(place, asDestination: target == .destination)
        } catch {
            dataMessage = "Letzter Ort konnte nicht gespeichert werden."
        }
    }

    func planToDestination(_ place: Place) async {
        guard !blockPausedPlanning() else { return }
        cancelPreviewReplanning()
        cancelReturnPlanning()
        guard !planningState.isLoading else { return }
        discardRoute()
        select(place, for: .destination)
        timingSelection = .now
        plannedDate = Date().addingTimeInterval(30 * 60)
        planningState = .locating
        let generation = planningGeneration

        let current: CLLocation?
        if let planningLocationProvider {
            current = await planningLocationProvider()
        } else {
            current = await locationForPlanning()
        }
        guard generation == planningGeneration else { return }
        guard !Task.isCancelled else {
            planningState = .idle
            return
        }
        guard let current, NavigationStartPolicy.isUsable(current) else {
            origin = nil
            planningState = .failed("Aktueller Standort fehlt. Wähle einen Start oder versuche es erneut.")
            return
        }
        origin = makeCurrentPlace(
            from: current,
            detail: location.hasPreciseLocation ? "Genauer Standort" : "Ungefährer Standort"
        )
        planningState = .idle
        await planRoute()
    }

    func planRoute() async {
        guard !blockPausedPlanning() else { return }
        guard !planningState.isLoading else { return }
        let generation = planningGeneration
        navigationStartState = .idle
        useCurrentLocationIfAvailableWhenNeeded()
        guard let origin, let destination else {
            planningState = .failed("Wähle Start und Ziel.")
            return
        }
        select(destination, for: .destination)
        planningState = .loading
        do {
            let request = RouteRequest(origin: origin, destination: destination, timing: routeTiming, stops: routeStops)
            let plannedJourneys = try await calculateAndSaveRoute(request)
            guard generation == planningGeneration, !Task.isCancelled else { return }
            journeyOptions = plannedJourneys
            journey = plannedJourneys.first
            isReplanningAfterNavigation = false
            planningState = .ready
        } catch is CancellationError {
            if generation == planningGeneration { planningState = .idle }
        } catch let error as RoutePlannerError {
            guard generation == planningGeneration, !Task.isCancelled else { return }
            planningIssues = RoutePlannerError.unique([error])
            planningState = .failed(error.localizedDescription)
        } catch {
            guard generation == planningGeneration, !Task.isCancelled else { return }
            planningIssues = [.localFailure]
            planningState = .failed("Route konnte nicht erstellt werden.")
        }
    }

    /// Applies a draft only after routing and persistence succeed. Returns a user-facing error.
    func applyRouteAdjustments(
        origin: Place,
        destination: Place,
        timingSelection: TimingSelection,
        plannedDate: Date,
        stops: [RouteStop] = []
    ) async -> String? {
        if let message = planningPauseMessage { return message }
        guard !planningState.isLoading else { return "Eine Route wird bereits berechnet." }
        cancelPreviewReplanning()
        let previousState = planningState
        let generation = planningGeneration
        planningState = .loading
        defer {
            if generation == planningGeneration, planningState == .loading {
                planningState = previousState
            }
        }
        let timing: RouteTiming = switch timingSelection {
        case .now: .leaveNow
        case .depart: .departAt(plannedDate)
        case .arrive: .arriveBy(plannedDate)
        }
        if timingSelection != .now, plannedDate < Date() {
            return "Wähle einen Zeitpunkt in der Zukunft."
        }
        do {
            let options = try await calculateAndSaveRoute(
                RouteRequest(origin: origin, destination: destination, timing: timing, stops: stops)
            )
            guard generation == planningGeneration, !Task.isCancelled else { return "Berechnung wurde abgebrochen." }
            select(origin, for: .origin)
            if self.destination != destination {
                select(destination, for: .destination)
            }
            self.timingSelection = timingSelection
            self.plannedDate = plannedDate
            journeyOptions = options
            journey = options.first
            isReplanningAfterNavigation = false
            planningState = .ready
            navigationStartState = .idle
            return nil
        } catch let error as RoutePlannerError {
            return error.localizedDescription
        } catch {
            return "Route konnte nicht erstellt werden. Versuche es erneut."
        }
    }

    private func calculateAndSaveRoute(_ request: RouteRequest) async throws -> [Journey] {
        try serverPause.check()
        cancelBikeTransferSearch()
        planningIssues = []
        let request = RouteRequest(origin: request.origin, destination: request.destination,
                                   timing: request.timing == .leaveNow ? .departAt(Date()) : request.timing, stops: request.stops)
        let generation = planningGeneration
        try RouteStop.validate(request.stops)
        guard !request.stops.isEmpty || request.origin.coordinate.distance(to: request.destination.coordinate) >= 30 else {
            throw RoutePlannerError.placesTooClose
        }
        let token = UUID()
        bikeTransferToken = token
        explicitlySelectedJourneyID = nil
        let upstream = planner.alternativeUpdates(request, settings: settings)
        let stream = AsyncThrowingStream<JourneyOptionsUpdate, Error> { continuation in
            let producer = Task {
                do {
                    for try await update in upstream {
                        try Task.checkCancellation()
                        continuation.yield(update)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            routingProducerTask = producer
            continuation.onTermination = { _ in producer.cancel() }
        }
        var iterator = stream.makeAsyncIterator()
        var initialUpdate: JourneyOptionsUpdate?
        var options: [Journey] = []
        while let update = try await iterator.next(isolation: MainActor.shared) {
            options = JourneyOptionSelector.select(from: update.journeys, timing: request.timing, cyclingLimit: settings.maxCyclingMinutes, showCyclingComparison: settings.showCyclingComparison)
            if !options.isEmpty { initialUpdate = update; break }
        }
        guard let initial = initialUpdate else { throw RoutePlannerError.noRoute }
        try Task.checkCancellation()
        guard generation == planningGeneration, token == bikeTransferToken else { throw CancellationError() }
        guard let first = options.first else { throw RoutePlannerError.noRoute }
        do { try store.saveActiveJourney(first) }
        catch { throw RoutePlannerError.storageFailure }
        previewTiming = request.timing
        bikeTransferSearchStatus = initial.status
        planningIssues = initial.issues
        if initial.status == .searching {
            bikeTransferTask = Task { [weak self] in
                guard let self else { return }
                defer { if bikeTransferToken == token { bikeTransferTask = nil } }
                do {
                    while let update = try await iterator.next(isolation: MainActor.shared) {
                        guard !Task.isCancelled, generation == planningGeneration,
                              bikeTransferToken == token, navigation == nil else { return }
                        var options = JourneyOptionSelector.select(from: update.journeys, timing: request.timing, cyclingLimit: settings.maxCyclingMinutes, showCyclingComparison: settings.showCyclingComparison)
                        if let selectedID = explicitlySelectedJourneyID, let selected = journey, selected.id == selectedID,
                           !options.contains(where: { $0.id == selectedID }) {
                            options = JourneyOptionSelector.retaining(selected, in: options, cyclingLimit: settings.maxCyclingMinutes, showComparison: settings.showCyclingComparison)
                        }
                        guard let first = options.first else { continue }
                        let selected = options.first { $0.id == explicitlySelectedJourneyID } ?? first
                        do { try store.saveActiveJourney(selected) }
                        catch { throw RoutePlannerError.storageFailure }
                        journeyOptions = options
                        journey = selected
                        bikeTransferSearchStatus = update.status
                        planningIssues = update.issues
                    }
                    if bikeTransferToken == token, bikeTransferSearchStatus == .searching { bikeTransferSearchStatus = .complete }
                } catch {
                    if !Task.isCancelled, generation == planningGeneration, bikeTransferToken == token {
                        bikeTransferSearchStatus = .partial
                        planningIssues = RoutePlannerError.unique(planningIssues + [.classify(error)])
                    }
                }
            }
        }
        return options
    }

    private func cancelBikeTransferSearch() {
        routingProducerTask?.cancel()
        routingProducerTask = nil
        bikeTransferToken = nil
        bikeTransferTask?.cancel()
        bikeTransferTask = nil
        bikeTransferSearchStatus = .complete
        planningIssues = []
    }

    func selectJourney(at index: Int) {
        guard !isReplanningAfterNavigation else { return }
        guard journeyOptions.indices.contains(index) else { return }
        let selection = journeyOptions[index]
        explicitlySelectedJourneyID = selection.id
        guard selection.id != journey?.id else { return }

        journey = selection
        navigationStartState = .idle
        do {
            try store.saveActiveJourney(selection)
        } catch {
            dataMessage = "Ausgewählte Route konnte nicht gespeichert werden."
        }
    }

    func replan(from origin: Place, to destination: Place, stops: [RouteStop] = []) async {
        guard !blockPausedPlanning() else { return }
        cancelPreviewReplanning()
        cancelReturnPlanning()
        guard !planningState.isLoading else { return }

        journey = nil
        journeyOptions = []
        navigationStartState = .idle
        planningState = .idle
        routeStops = stops
        self.origin = origin
        self.destination = destination
        timingSelection = .now
        plannedDate = Date().addingTimeInterval(30 * 60)

        do {
            try store.clearActiveJourney()
        } catch {
            dataMessage = "Vorherige Route konnte nicht entfernt werden."
        }

        await planRoute()
    }

    func deleteHistoryEntry(id: String) throws {
        try store.deleteJourney(id: id)
    }

    func refreshHistoryPlaceNames(_ journeys: [StoredJourney]) async {
        for journey in journeys {
            let originName = await resolvedLegacyHistoryName(
                currentName: journey.originName,
                place: journey.originPlace
            )
            let destinationName = await resolvedLegacyHistoryName(
                currentName: journey.destinationName,
                place: journey.destinationPlace
            )
            guard originName != nil || destinationName != nil else { continue }

            do {
                try store.updateJourneyNames(
                    id: journey.id,
                    originName: originName,
                    destinationName: destinationName
                )
            } catch {
                dataMessage = "Ortsname im Verlauf konnte nicht aktualisiert werden."
            }
        }
    }

    func discardRoute() {
        routeStops = []
        cancelPreviewReplanning()
        cancelBikeTransferSearch()
        cancelReturnPlanning()
        navigationGeneration += 1
        planningGeneration += 1
        origin = nil
        destination = nil
        previewTiming = nil
        journey = nil
        journeyOptions = []
        planningState = .idle
        navigationStartState = .idle
        do {
            try store.clearActiveJourney()
        } catch {
            dataMessage = "Gespeicherte Route konnte nicht entfernt werden."
        }
    }

    func startNavigation() async {
        guard !isReplanningAfterNavigation, !planningState.isLoading else { return }
        cancelBikeTransferSearch()
        guard let journey, !navigationStartState.isLoading else { return }
        do {
            try StreetGeometryValidator.validate(journey)
        } catch {
            navigationStartState = .failed(error.localizedDescription)
            return
        }
        navigationGeneration += 1
        let generation = navigationGeneration
        navigationStartState = .locating
        let current = await refreshedLocation()
        guard generation == navigationGeneration, !Task.isCancelled else { return }
        guard let current else {
            navigationStartState = .failed(
                "Kein aktueller, genauer Standort. Standortzugriff prüfen und erneut versuchen."
            )
            return
        }

        switch NavigationStartPolicy.decision(
            location: current,
            origin: journey.origin.coordinate
        ) {
        case .start:
            navigationStartState = .idle
            do {
                try activateNavigation(with: journey, startLocationUpdates: true)
            } catch {
                guard generation == navigationGeneration, !Task.isCancelled else { return }
                navigationStartState = .failed((error as? RoutePlannerError)?.localizedDescription
                    ?? "Navigation konnte nicht gespeichert werden. Versuche es erneut.")
            }
        case .approach:
            navigationStartState = .preparingApproach
            do {
                let combined = try await makeApproachJourney(
                    from: current,
                    waypoint: journey.origin,
                    onward: journey
                )
                guard generation == navigationGeneration, !Task.isCancelled else { return }
                self.journey = combined
                journeyOptions = [combined]
                try store.saveActiveJourney(combined)
                navigationStartState = .idle
                try activateNavigation(with: combined, startLocationUpdates: true)
            } catch let error as RoutePlannerError {
                guard generation == navigationGeneration, !Task.isCancelled else { return }
                navigationStartState = .failed(error.localizedDescription)
            } catch {
                guard generation == navigationGeneration, !Task.isCancelled else { return }
                navigationStartState = .failed("Route zum Start konnte nicht erstellt werden.")
            }
        case .tooFar(let distance):
            navigationStartState = .distantStart(distance: distance)
        case .unavailable:
            navigationStartState = .failed(
                "Kein aktueller, genauer Standort. Standortzugriff prüfen und erneut versuchen."
            )
        }
    }

    func replanFromCurrentLocation() async {
        guard let activeJourney = journey else { return }
        navigationGeneration += 1
        let generation = navigationGeneration
        navigationStartState = .locating
        let current = await refreshedLocation()
        guard generation == navigationGeneration, !Task.isCancelled else { return }
        guard let current else {
            navigationStartState = .failed("Aktueller Standort fehlt. Versuche es erneut.")
            return
        }

        navigationStartState = .preparingApproach
        let currentPlace = makeCurrentPlace(from: current, detail: "Neuer Start")
        do {
            let replacements = Array(
                try await planner.planAlternatives(
                    RouteRequest(
                        origin: currentPlace,
                        destination: activeJourney.destination,
                        timing: .leaveNow, stops: activeJourney.stops
                    ),
                    settings: settings
                )
                .prefix(JourneyOptionSelector.maximumDisplayedOptions)
            )
            guard generation == navigationGeneration, !Task.isCancelled else { return }
            guard let replacement = replacements.first else {
                throw RoutePlannerError.noRoute
            }
            origin = currentPlace
            journeyOptions = replacements
            journey = replacement
            try store.saveActiveJourney(replacement)
            planningState = .ready
            navigationStartState = .idle
        } catch let error as RoutePlannerError {
            guard generation == navigationGeneration, !Task.isCancelled else { return }
            navigationStartState = .failed(error.localizedDescription)
        } catch {
            guard generation == navigationGeneration, !Task.isCancelled else { return }
            navigationStartState = .failed("Route ab aktuellem Standort konnte nicht erstellt werden.")
        }
    }

    func cancelNavigationPreparation() {
        navigationGeneration += 1
        navigationStartState = .idle
    }

    func stopNavigation(discardRoute: Bool = false) {
        cancelBikeTransferSearch()
        cancelReturnPlanning()
        navigationGeneration += 1
        stopTransitRefresh()
        navigationClock?.cancel()
        navigationClock = nil
        location.stopNavigation()
        navigationAlerts?.cancel()
        navigationAlerts = nil
        guidance.cancelAlerts()
        navigation = nil
        do {
            try store.clearActiveJourney()
        } catch {
            dataMessage = "Beendete Navigation konnte nicht aus dem Speicher entfernt werden."
        }
        if discardRoute { self.discardRoute() }
    }

    /// Own the task here: stopping navigation removes ActiveNavigationView immediately.
    @discardableResult
    func stopNavigationAndReplan() -> Task<Void, Never>? {
        guard let engine = navigation, engine.phase != .arrived else { return nil }
        let previous = engine.journey
        stopNavigation()
        journey = previous
        routeStops = previous.remainingStops(from: engine.currentLegIndex)
        journeyOptions = []
        destination = previous.destination
        origin = nil
        timingSelection = .now
        navigationStartState = .idle
        isReplanningAfterNavigation = true
        return retryPlanningAfterNavigation()
    }

    @discardableResult
    func retryPlanningAfterNavigation() -> Task<Void, Never>? {
        guard !blockPausedPlanning() else { return nil }
        guard isReplanningAfterNavigation, let destination, !planningState.isLoading else { return nil }
        returnPlanningTask?.cancel()
        planningGeneration += 1
        let generation = planningGeneration
        origin = nil
        timingSelection = .now
        planningState = .locating
        let task = Task { [weak self] in
            guard let self else { return }
            defer { if generation == planningGeneration { returnPlanningTask = nil } }
            let current: CLLocation?
            if let planningLocationProvider {
                current = await planningLocationProvider()
            } else {
                current = await locationForPlanning()
            }
            guard generation == planningGeneration, !Task.isCancelled else { return }
            guard let current, NavigationStartPolicy.isUsable(current) else {
                planningState = .failed("Aktueller Standort fehlt. Wähle einen Start oder versuche es erneut.")
                return
            }
            let start = makeCurrentPlace(from: current, detail: location.hasPreciseLocation ? "Genauer Standort" : "Ungefährer Standort")
            origin = start
            planningState = .loading
            do {
                let options = try await calculateAndSaveRoute(RouteRequest(origin: start, destination: destination, timing: .leaveNow, stops: routeStops))
                guard generation == planningGeneration, !Task.isCancelled else { return }
                journeyOptions = options
                journey = options.first
                planningState = .ready
                isReplanningAfterNavigation = false
            } catch {
                guard generation == planningGeneration, !Task.isCancelled else { return }
                planningState = .failed((error as? RoutePlannerError)?.localizedDescription ?? "Routen konnten nicht neu berechnet werden. Versuche es erneut.")
            }
        }
        returnPlanningTask = task
        return task
    }

    private func cancelReturnPlanning() {
        guard isReplanningAfterNavigation || returnPlanningTask != nil else { return }
        planningGeneration += 1
        returnPlanningTask?.cancel()
        returnPlanningTask = nil
        isReplanningAfterNavigation = false
        planningState = .idle
    }

    private func invalidateRouteForSettings() {
        guard navigation == nil, destination != nil else { return }
        if planningRequestsPaused {
            settingsReplanPending = true
            return
        }
        invalidatePreview()
        settingsReplanPending = true
    }

    @discardableResult
    func refreshPlannedRoutes() -> Task<Void, Never>? {
        guard !blockPausedPlanning() else { return nil }
        guard navigation == nil, journey != nil, destination != nil,
              !planningState.isLoading, !navigationStartState.isLoading,
              !isReplanningAfterNavigation, !isPreviewReplan, previewReplanTask == nil else { return nil }
        let previous = journey
        let previousOptions = journeyOptions
        invalidatePreview()
        let generation = planningGeneration
        guard let refresh = retryPreviewPlanning() else { return nil }
        return Task { [weak self] in
            await refresh.value
            guard let self, generation == planningGeneration, !Task.isCancelled,
                  case .failed = planningState, !planningIssues.isEmpty else { return }
            journey = previous
            journeyOptions = previousOptions
            if let previous {
                do { try store.saveActiveJourney(previous) }
                catch { dataMessage = "Route konnte nicht gespeichert werden." }
            }
        }
    }

    private func invalidatePreview() {
        previewReplanTask?.cancel()
        previewReplanTask = nil
        cancelBikeTransferSearch()
        cancelReturnPlanning()
        cancelNavigationPreparation()
        planningGeneration += 1
        settingsReplanPending = false
        isPreviewReplan = true
        explicitlySelectedJourneyID = nil
        journey = nil
        journeyOptions = []
        planningState = .idle
        do { try store.clearActiveJourney() }
        catch { dataMessage = "Gespeicherte Route konnte nicht entfernt werden." }
    }

    private func cancelPreviewReplanning() {
        guard settingsReplanPending || isPreviewReplan || previewReplanTask != nil else { return }
        planningGeneration += 1
        previewReplanTask?.cancel()
        previewReplanTask = nil
        settingsReplanPending = false
        isPreviewReplan = false
        cancelBikeTransferSearch()
        planningState = .idle
    }

    @discardableResult
    func finishSettingsEditing() -> Task<Void, Never>? {
        saveSettings()
        guard settingsReplanPending, !blockPausedPlanning() else { return nil }
        if !isPreviewReplan { invalidatePreview() }
        return retryPreviewPlanning()
    }

    @discardableResult
    func retryPreviewPlanning() -> Task<Void, Never>? {
        guard !blockPausedPlanning() else { return nil }
        guard navigation == nil, isPreviewReplan, destination != nil,
              previewReplanTask == nil else { return nil }
        settingsReplanPending = false
        let generation = planningGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            defer { if generation == planningGeneration { previewReplanTask = nil } }
            guard generation == planningGeneration, !Task.isCancelled else { return }
            if timingSelection != .now && plannedDate < Date() {
                planningState = .failed("Der gewählte Zeitpunkt liegt in der Vergangenheit. Passe die Route an.")
                return
            }
            if origin == nil || origin?.name == "Aktueller Standort" || destination?.name == "Aktueller Standort" {
                planningState = .locating
                let current: CLLocation?
                if let planningLocationProvider { current = await planningLocationProvider() }
                else { current = await locationForPlanning() }
                guard generation == planningGeneration, !Task.isCancelled else { return }
                guard let current, NavigationStartPolicy.isUsable(current) else {
                    planningState = .failed("Aktueller Standort fehlt. Wähle einen Ort oder versuche es erneut.")
                    return
                }
                let place = makeCurrentPlace(from: current, detail: location.hasPreciseLocation ? "Genauer Standort" : "Ungefährer Standort")
                if origin == nil || origin?.name == "Aktueller Standort" { origin = place }
                if destination?.name == "Aktueller Standort" { destination = place }
            }
            if timingSelection != .now && plannedDate < Date() {
                planningState = .failed("Der gewählte Zeitpunkt liegt in der Vergangenheit. Passe die Route an.")
                return
            }
            planningState = .idle
            await planRoute()
            guard generation == planningGeneration, !Task.isCancelled else { return }
            if planningState == .ready { isPreviewReplan = false }
        }
        previewReplanTask = task
        return task
    }

    func saveSettings() {
        navigation?.settings = settings
        do {
            try store.saveSettings(settings)
            dataMessage = "Einstellungen gespeichert."
        } catch {
            dataMessage = "Einstellungen konnten nicht gespeichert werden."
        }
    }

    func clearLocalData() {
        cancelPreviewReplanning()
        stopNavigation()
        do {
            try store.clearAll()
            planningGeneration += 1
            origin = nil
            destination = nil
            settings = .defaults
            journey = nil
            journeyOptions = []
            planningState = .idle
            navigationStartState = .idle
            dataMessage = "Lokale Daten gelöscht."
        } catch {
            dataMessage = "Lokale Daten konnten nicht gelöscht werden."
        }
    }

    private func useCurrentLocationIfAvailableWhenNeeded() {
        if origin == nil { useCurrentLocationIfAvailable() }
    }

    private func handle(_ location: CLLocation) {
        if origin == nil { useCurrentLocationIfAvailable() }
        navigation?.update(location: location)
        requestTransitRefresh()
    }

    private func startClock() {
        navigationClock?.cancel()
        navigationClock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                self?.requestTransitRefresh()
                self?.navigation?.tick()
            }
        }
    }

    func continueFromStop(now: Date = Date()) async {
        guard let engine = navigation, engine.currentLeg?.kind == .stop, !engine.isReplanning,
              let updated = engine.journeyAfterStop(now: now) else { return }
        let nextIndex = engine.currentLegIndex + 1
        if updated.remainingTransit(from: nextIndex).allSatisfy({ TransitRefreshPolicy.canUseTimes($0, now: now) }),
           TransitJourneyUpdater.disruption(in: updated, from: engine.currentLegIndex, now: now) == nil {
            engine.continueFromStop(with: updated, now: now)
            journey = engine.journey
            journeyOptions = [engine.journey]
            return
        }
        engine.setReplanning(true, message: "Weiterfahrt wird neu berechnet …")
        let stopID = engine.currentLeg?.id
        let current = await refreshedLocation()
        guard navigation === engine, engine.currentLeg?.id == stopID, !Task.isCancelled else { return }
        guard let current else { engine.setReplanning(false, message: "Standort fehlt. Weiterfahren erneut versuchen."); return }
        do {
            let request = RouteRequest(origin: makeCurrentPlace(from: current, detail: "Weiterfahrt"),
                destination: engine.journey.destination, timing: .departAt(now),
                stops: engine.journey.remainingStops(from: nextIndex))
            let replacement = try await planner.plan(request, settings: settings)
            guard navigation === engine, engine.currentLeg?.id == stopID, !Task.isCancelled else { return }
            try activateNavigation(with: replacement, startLocationUpdates: false)
            journey = replacement
            journeyOptions = [replacement]
        } catch {
            guard navigation === engine else { return }
            engine.setReplanning(false, message: "Weiterfahrt konnte nicht neu berechnet werden. Erneut versuchen.")
        }
    }

    private func rerouteActiveNavigationFromCurrentLocation() async {
        guard let activeEngine = navigation else { return }
        guard let current = location.currentLocation, let activeJourney = journey else {
            navigation?.setReplanning(false, message: "Standort fehlt. Alte Route bleibt aktiv.")
            return
        }
        do {
            let replacement: Journey
            if navigation?.currentLeg?.kind == .approach,
               let waypoint = activeJourney.waypoint,
               let onward = ApproachJourneyComposer.onwardJourney(from: activeJourney) {
                replacement = try await makeApproachJourney(
                    from: current,
                    waypoint: waypoint,
                    onward: onward
                )
            } else {
                let currentPlace = makeCurrentPlace(from: current, detail: "Neuplanung")
                let request = RouteRequest(
                    origin: currentPlace,
                    destination: activeJourney.destination,
                    timing: .leaveNow, stops: activeJourney.remainingStops(from: activeEngine.currentLegIndex)
                )
                replacement = try await planner.plan(request, settings: settings)
            }
            guard navigation === activeEngine, !Task.isCancelled else { return }
            try activateNavigation(with: replacement, startLocationUpdates: false)
            journey = replacement
            journeyOptions = [replacement]
        } catch {
            guard navigation === activeEngine else { return }
            navigation?.setReplanning(false, message: "Neuplanung fehlgeschlagen. Alte Route bleibt aktiv.")
        }
    }

    private func makeApproachJourney(
        from location: CLLocation,
        waypoint: Place,
        onward: Journey
    ) async throws -> Journey {
        switch NavigationStartPolicy.decision(location: location, origin: waypoint.coordinate) {
        case .start, .approach:
            break
        case .tooFar, .unavailable:
            throw RoutePlannerError.noRoute
        }
        let currentPlace = makeCurrentPlace(from: location, detail: "Start der Anfahrt")
        let approach = try await planner.planDirectBike(
            RouteRequest(origin: currentPlace, destination: waypoint, timing: .leaveNow),
            settings: settings
        )
        let usableOnward: Journey
        if ApproachJourneyComposer.canKeepConnection(
            approachArrival: approach.arrival,
            onwardDeparture: onward.departure
        ) {
            usableOnward = onward
        } else {
            let earliestOnwardDeparture = approach.arrival.addingTimeInterval(
                ApproachJourneyComposer.connectionBuffer
            )
            usableOnward = try await planner.plan(
                RouteRequest(
                    origin: waypoint,
                    destination: onward.destination,
                    timing: .departAt(earliestOnwardDeparture), stops: onward.stops
                ),
                settings: settings
            )
        }
        return try ApproachJourneyComposer.compose(
            approach: approach,
            onward: usableOnward,
            waypoint: waypoint
        )
    }

    private func makeCurrentPlace(from location: CLLocation, detail: String) -> Place {
        Place(
            name: "Aktueller Standort",
            detail: detail,
            coordinate: Coordinate(location.coordinate)
        )
    }

    private func refreshedLocation() async -> CLLocation? {
        if let current = location.currentLocation, NavigationStartPolicy.isUsable(current) {
            return current
        }

        location.requestSingleUpdate()
        for _ in 0..<20 {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return nil }
            if let current = location.currentLocation, NavigationStartPolicy.isUsable(current) {
                return current
            }
        }
        return nil
    }

    func currentPlaceForSelection() async -> Place? {
        guard let current = await locationForPlanning(), !Task.isCancelled else { return nil }
        return makeCurrentPlace(
            from: current,
            detail: location.hasPreciseLocation ? "Genauer Standort" : "Ungefährer Standort"
        )
    }

    private func locationForPlanning() async -> CLLocation? {
        location.requestAuthorization()
        // The permission dialog is user-paced; start the GPS timeout only after a decision.
        while location.authorizationStatus == .notDetermined {
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled else { return nil }
        }
        guard location.isAuthorized else { return nil }
        return await refreshedLocation()
    }

    private func activateNavigation(
        with journey: Journey,
        startLocationUpdates: Bool,
        progress: NavigationProgress = NavigationProgress(legIndex: 0, maneuverIndex: 0)
    ) throws {
        guard progress.isValid(for: journey) else { throw RoutePlannerError.noRoute }
        try StreetGeometryValidator.validate(journey, startingAt: progress.legIndex)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: journey, progress: progress))
        let engine = NavigationEngine(journey: journey, settings: settings, guidance: guidance)
        engine.onReroute = { [weak self, weak engine] in
            Task {
                guard let self, let engine, self.navigation === engine else { return }
                await self.rerouteActiveNavigationFromCurrentLocation()
            }
        }
        engine.onArrival = { [weak self, weak engine] in
            guard let self, let engine, self.navigation === engine else { return }
            self.handleArrival()
        }
        engine.onProgress = { [weak self, weak engine] progress in
            guard let self, let engine, self.navigation === engine else { return }
            if self.navigationAlternative?.sourceLegID != engine.currentLeg?.id {
                self.navigationAlternative = nil
                self.lastAlternativeIssueID = nil
            }
            self.updateTransitAlerts(for: engine)
            do {
                try self.store.saveActiveSnapshot(ActiveJourneySnapshot(journey: engine.journey, progress: progress))
            } catch {
                engine.setReplanning(false, message: "Navigationsfortschritt konnte nicht gespeichert werden.")
            }
        }
        stopTransitRefresh()
        navigation = engine
        hasRecordedArrival = false
        if startLocationUpdates { location.startNavigation() }
        engine.start(progress: progress)
        startClock()
        updateTransitAlerts(for: engine, requestAuthorization: true)
        requestTransitRefresh()
    }

    private func updateTransitAlerts(for engine: NavigationEngine, requestAuthorization: Bool = false) {
        navigationAlerts?.cancel()
        guidance.cancelAlerts()
        navigationAlerts = Task { [weak self, weak engine] in
            guard let self, let engine else { return }
            if requestAuthorization { await guidance.requestNotificationAuthorization() }
            guard !Task.isCancelled, navigation === engine else { return }
            await guidance.scheduleTransitAlerts(for: engine.journey, startingAt: engine.currentLegIndex, settings: settings)
        }
    }

    private func stopTransitRefresh() {
        transitRefreshTask?.cancel()
        transitRefreshTask = nil
        transitRefreshToken = nil
        transitDue = [:]
        transitFailures = [:]
        transitRateLimitedUntil = nil
        alternativeTask?.cancel()
        alternativeTask = nil
        navigationAlternative = nil
        transitDisruption = nil
        alternativeMessage = nil
        isFindingAlternative = false
        lastAlternativeIssueID = nil
    }

    func requestTransitRefresh(now: Date = Date()) {
        guard let engine = navigation, engine.phase != .arrived, transitRefreshToken == nil, transitRefreshTask == nil,
              transitRateLimitedUntil.map({ $0 <= now }) ?? true,
              engine.journey.remainingTransit(from: engine.currentLegIndex).contains(where: { transitDue[$0.id, default: .distantPast] <= now }) else { return }
        transitRefreshTask = Task { [weak self, weak engine] in
            await self?.refreshTransit(now: now)
            if let self, let engine, self.navigation === engine { self.transitRefreshTask = nil }
        }
    }

    // Also called directly by deterministic tests; all triggers share this gate.
    func refreshTransit(now: Date = Date()) async {
        guard let engine = navigation, engine.phase != .arrived, transitRefreshToken == nil,
              transitRateLimitedUntil.map({ $0 <= now }) ?? true else { return }
        let legs = engine.journey.remainingTransit(from: engine.currentLegIndex).filter { transitDue[$0.id, default: .distantPast] <= now }
        guard !legs.isEmpty else { return }
        let token = UUID()
        transitRefreshToken = token
        defer { if transitRefreshToken == token { transitRefreshToken = nil } }
        let startedAt = Date()
        let results = await transitRefresher.refresh(legs)
        let completedAt = now.addingTimeInterval(Date().timeIntervalSince(startedAt))
        guard !Task.isCancelled, navigation === engine, engine.phase != .arrived, transitRefreshToken == token else { return }
        for leg in legs {
            switch results[leg.id] {
            case .updated(let update):
                transitFailures[leg.id] = 0
                transitDue[leg.id] = max(completedAt, update.receivedAt ?? completedAt).addingTimeInterval(TransitRefreshPolicy.interval)
            case .unavailable:
                transitDue[leg.id] = completedAt.addingTimeInterval(300)
            case .failed(let retryAfter):
                if let retryAfter {
                    transitRateLimitedUntil = max(transitRateLimitedUntil ?? .distantPast, completedAt.addingTimeInterval(retryAfter))
                }
                transitFailures[leg.id, default: 0] += 1
                transitDue[leg.id] = completedAt.addingTimeInterval(TransitRefreshPolicy.retryDelay(failures: transitFailures[leg.id]!, retryAfter: retryAfter))
            case nil:
                transitDue[leg.id] = completedAt.addingTimeInterval(120)
            }
        }
        let updated = TransitJourneyUpdater.apply(results, to: engine.journey, from: engine.currentLegIndex, now: completedAt)
        engine.applyTransitJourney(updated)
        journey = updated
        journeyOptions = [updated]
        do {
            try store.saveActiveSnapshot(ActiveJourneySnapshot(
                journey: updated, progress: NavigationProgress(legIndex: engine.currentLegIndex, maneuverIndex: engine.currentManeuverIndex)
            ))
        } catch {
            engine.setReplanning(false, message: "Aktualisierte Navigation konnte nicht gespeichert werden.")
        }
        updateTransitAlerts(for: engine)
        var remainingTime: TimeInterval?
        if let leg = engine.currentLeg, [.bike, .walk, .approach].contains(leg.kind),
           let current = location.currentLocation, NavigationStartPolicy.isUsable(current), leg.distance > 0 {
            let fraction = min(1, Coordinate(current.coordinate).distance(to: leg.endPlace.coordinate) / leg.distance)
            remainingTime = fraction * leg.endTime.timeIntervalSince(leg.startTime)
        }
        transitDisruption = TransitJourneyUpdater.disruption(in: updated, from: engine.currentLegIndex, now: completedAt, remainingMovementTime: remainingTime)
        if let issue = transitDisruption {
            engine.announceChange(issue.id, message: issue.message)
            if lastAlternativeIssueID != issue.id { proposeNavigationAlternative() }
        } else {
            lastAlternativeIssueID = nil
            navigationAlternative = nil
        }
    }

    func proposeNavigationAlternative() {
        guard let engine = navigation, let currentLeg = engine.currentLeg,
              engine.phase != .arrived, !isFindingAlternative else { return }
        if currentLeg.kind == .stop { return }
        if case .transit(let transit) = currentLeg, transit.isCancelled {
            alternativeMessage = "Ausstieg vor Ort prüfen. Nach dem Ausstieg mit Schritt fertig bestätigen und neu berechnen."
            lastAlternativeIssueID = transitDisruption?.id
            return
        }
        isFindingAlternative = true
        alternativeMessage = nil
        let issueID = transitDisruption?.id
        lastAlternativeIssueID = issueID
        alternativeTask = Task { [weak self, weak engine] in
            guard let self, let engine else { return }
            defer { if navigation === engine { isFindingAlternative = false } }
            let start: Place
            let departure: Date
            var prefix: [JourneyLeg] = []
            let progress: NavigationProgress
            if case .transit(let transit) = currentLeg {
                start = transit.to
                let arrival = max(Date(), transit.endTime)
                departure = arrival.addingTimeInterval(settings.unfoldDuration)
                prefix = Array(engine.journey.legs.prefix(engine.currentLegIndex + 1))
                prefix.append(.unfold(TransitionLeg(place: start, startTime: arrival, endTime: departure)))
                progress = NavigationProgress(legIndex: engine.currentLegIndex, maneuverIndex: 0)
            } else {
                let current = await refreshedLocation()
                guard !Task.isCancelled, navigation === engine, engine.currentLeg?.id == currentLeg.id else { return }
                guard let current else {
                    alternativeMessage = "Aktueller Standort fehlt. Erneut versuchen."
                    return
                }
                start = makeCurrentPlace(from: current, detail: "Alternative ab hier")
                departure = Date()
                progress = NavigationProgress(legIndex: 0, maneuverIndex: 0)
            }
            do {
                let route = try await planner.plan(RouteRequest(origin: start, destination: engine.journey.destination, timing: .departAt(departure), stops: engine.journey.remainingStops(from: engine.currentLegIndex)), settings: settings)
                guard !Task.isCancelled, navigation === engine, engine.currentLeg?.id == currentLeg.id,
                      transitDisruption?.id == issueID else { return }
                let combined = prefix.isEmpty ? route : Journey(
                    id: route.id, origin: engine.journey.origin, destination: route.destination,
                    departure: engine.journey.departure, arrival: route.arrival,
                    legs: prefix + route.legs, transfers: route.transfers, isDirect: false, score: route.score
                )
                navigationAlternative = NavigationAlternative(journey: combined, progress: progress, sourceLegID: currentLeg.id, issueID: issueID, sourceArrival: currentLeg.kind == .transit ? currentLeg.endTime : nil)
            } catch {
                guard !Task.isCancelled, navigation === engine else { return }
                alternativeMessage = "Keine neue Verbindung verfügbar. Erneut versuchen."
            }
        }
    }

    func acceptNavigationAlternative() {
        guard let engine = navigation, let candidate = navigationAlternative,
              candidate.sourceLegID == engine.currentLeg?.id, candidate.issueID == transitDisruption?.id else { return }
        guard Date().timeIntervalSince(candidate.createdAt) <= 120,
              candidate.sourceArrival == nil || candidate.sourceArrival == engine.currentLeg?.endTime else {
            navigationAlternative = nil
            proposeNavigationAlternative()
            return
        }
        do {
            try activateNavigation(with: candidate.journey, startLocationUpdates: true, progress: candidate.progress)
            journey = candidate.journey
            origin = candidate.journey.origin
            destination = candidate.journey.destination
            journeyOptions = [candidate.journey]
        } catch {
            alternativeMessage = "Alternative konnte nicht gespeichert werden."
        }
    }

    func dismissNavigationAlternative() {
        navigationAlternative = nil
    }

    private func handleArrival() {
        stopTransitRefresh()
        location.stopNavigation()
        navigationAlerts?.cancel()
        navigationAlerts = nil
        guidance.cancelAlerts()
        navigationClock?.cancel()
        navigationClock = nil
        guard !hasRecordedArrival, let journey else { return }
        hasRecordedArrival = true
        do {
            try store.clearActiveJourney()
            try store.record(journey)
            Task { [weak self] in
                await self?.resolveHistoryPlaceNames(for: journey)
            }
        } catch {
            dataMessage = "Fahrt konnte nicht im Verlauf gespeichert werden."
        }
    }

    private func resolveHistoryPlaceNames(for journey: Journey) async {
        let originName = await resolvedHistoryName(for: journey.origin)
        let destinationName = await resolvedHistoryName(for: journey.destination)
        guard originName != nil || destinationName != nil else { return }

        do {
            try store.updateJourneyNames(
                id: journey.id,
                originName: originName,
                destinationName: destinationName
            )
        } catch {
            dataMessage = "Ortsname im Verlauf konnte nicht aktualisiert werden."
        }
    }

    private func resolvedHistoryName(for place: Place) async -> String? {
        guard place.name == "Aktueller Standort" else { return nil }
        return try? await historyPlaceNameResolver.displayName(for: place.coordinate)
    }

    private func resolvedLegacyHistoryName(
        currentName: String,
        place: Place?
    ) async -> String? {
        guard currentName == "Aktueller Standort", let place else { return nil }
        return await resolvedHistoryName(for: place) ?? "Startpunkt"
    }
}

enum PlaceLookupError: Error {
    case noPlace, expiredSuggestion, timedOut
}

@MainActor
final class PlaceSearchService: PlaceSearching {
    private var pendingCompletion: CompletionRequest?
    private var pendingSearch: MKLocalSearch?
    private var pendingSearchID: UUID?
    private var completions: [UUID: MKLocalSearchCompletion] = [:]

    func search(_ query: String, near center: Coordinate) async throws -> [PlaceSuggestion] {
        pendingCompletion?.cancel()
        let request = CompletionRequest(query: query, center: center)
        pendingCompletion = request
        defer { if pendingCompletion === request { pendingCompletion = nil } }
        try await request.run()
        try Task.checkCancellation()
        let matches = request.results
        var suggestions: [PlaceSuggestion] = []
        var mapped: [UUID: MKLocalSearchCompletion] = [:]
        var labels: Set<String> = []
        for completion in matches {
            guard labels.insert(completion.title + "\n" + completion.subtitle).inserted else { continue }
            let suggestion = PlaceSuggestion(title: completion.title, subtitle: completion.subtitle)
            suggestions.append(suggestion)
            mapped[suggestion.id] = completion
            if suggestions.count == 12 { break }
        }
        completions = mapped
        return suggestions
    }

    func resolve(_ suggestion: PlaceSuggestion) async throws -> [Place] {
        guard let completion = completions[suggestion.id] else { throw PlaceLookupError.expiredSuggestion }
        let request = MKLocalSearch.Request(completion: completion)
        request.resultTypes = [.address, .pointOfInterest]
        let search = MKLocalSearch(request: request)
        let lookupID = UUID()
        pendingSearch = search
        pendingSearchID = lookupID
        defer {
            if pendingSearchID == lookupID {
                pendingSearch = nil
                pendingSearchID = nil
            }
        }
        let response = try await withTaskCancellationHandler {
            try await search.start()
        } onCancel: {
            Task { @MainActor in
                if self.pendingSearchID == lookupID { self.pendingSearch?.cancel() }
            }
        }
        try Task.checkCancellation()
        return response.mapItems.map { item in
            let placemark = item.placemark
            let details = [placemark.thoroughfare, placemark.locality]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
            return Place(
                name: item.name ?? placemark.title ?? "Ort",
                detail: details,
                coordinate: Coordinate(placemark.coordinate)
            )
        }
    }

    func cancel() {
        pendingCompletion?.cancel()
        pendingCompletion = nil
        pendingSearch?.cancel()
        pendingSearch = nil
        pendingSearchID = nil
        // Keep completion tokens for the visible list when the arrow prefills text.
    }
}

/// Each query owns its delegate, so a late callback cannot be attributed to newer text.
@MainActor
private final class CompletionRequest: NSObject, MKLocalSearchCompleterDelegate {
    private let query: String
    private let completer = MKLocalSearchCompleter()
    private var continuation: CheckedContinuation<Void, Error>?
    private(set) var results: [MKLocalSearchCompletion] = []
    private var timeout: Task<Void, Never>?

    init(query: String, center: Coordinate) {
        self.query = query
        super.init()
        completer.resultTypes = [.address, .pointOfInterest]
        completer.region = MKCoordinateRegion(
            center: center.clCoordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.7, longitudeDelta: 0.9)
        )
        completer.delegate = self
    }

    func run() async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                completer.queryFragment = query
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(15)) }
                    catch { return }
                    self?.finish(.failure(PlaceLookupError.timedOut))
                }
            }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    func cancel() { finish(.failure(CancellationError())) }

    private func finish(_ result: Result<Void, Error>) {
        let waiting = continuation
        continuation = nil
        timeout?.cancel()
        timeout = nil
        completer.delegate = nil
        completer.cancel()
        waiting?.resume(with: result)
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.results = self.completer.results
            self.finish(.success(()))
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        Task { @MainActor [weak self] in self?.finish(.failure(error)) }
    }
}
