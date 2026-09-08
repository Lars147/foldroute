import CoreLocation
import Foundation
import SwiftData
import XCTest
@testable import FoldRoute

final class BikeTransferTests: XCTestCase, @unchecked Sendable {
    private let date = Date(timeIntervalSince1970: 2_000_000_000)
    private let origin = Place(name: "Start", coordinate: Coordinate(latitude: 48, longitude: 11))
    private let stop = Place(name: "A", coordinate: Coordinate(latitude: 48.01, longitude: 11))
    private let destination = Place(name: "Ziel", coordinate: Coordinate(latitude: 48.2, longitude: 11))

    private func transit(_ from: Place, _ to: Place, _ start: Date, _ duration: Double, id: String = UUID().uuidString) -> JourneyLeg {
        .transit(TransitLeg(from: from, to: to, startTime: start, endTime: start.addingTimeInterval(duration),
            mode: "SUBWAY", line: id, headsign: to.name, agency: "Test", departurePlatform: "1", arrivalPlatform: nil,
            isRealtime: true, isCancelled: false, coordinates: [from.coordinate, to.coordinate],
            reference: TransitReference(tripID: id, fromID: from.name, toID: to.name,
                scheduledDeparture: start, scheduledArrival: start.addingTimeInterval(duration)), lastUpdatedAt: date))
    }

    private func bike(_ from: Place, _ to: Place, _ start: Date, _ duration: Double) -> JourneyLeg {
        .bike(MovementLeg(from: from, to: to, startTime: start, endTime: start.addingTimeInterval(duration), distance: 500,
            coordinates: [from.coordinate, to.coordinate], maneuvers: []))
    }

    private func journey(_ legs: [JourneyLeg], id: String = UUID().uuidString) -> Journey {
        Journey(id: id, origin: legs.first!.startPlace, destination: legs.last!.endPlace,
            departure: legs.first!.startTime, arrival: legs.last!.endTime, legs: legs,
            transfers: max(0, legs.filter { $0.kind == .transit }.count - 1), isDirect: false, score: legs.last!.endTime.timeIntervalSince1970)
    }

    private func base() -> Journey {
        journey([transit(origin, stop, date, 600),
            .unfold(TransitionLeg(place: stop, startTime: date.addingTimeInterval(600), endTime: date.addingTimeInterval(720))),
            bike(stop, destination, date.addingTimeInterval(720), 3_000)], id: "base")
    }

    private func part(_ request: RouteRequest) -> Journey {
        let boarding = Place(name: UUID().uuidString, coordinate: Coordinate(latitude: request.origin.coordinate.latitude + 0.005, longitude: 11))
        let alighting = Place(name: UUID().uuidString, coordinate: Coordinate(latitude: (boarding.coordinate.latitude + request.destination.coordinate.latitude) / 2, longitude: 11))
        let start = request.timing.isArrival ? request.timing.date.addingTimeInterval(-1_620) : request.timing.date
        return journey([
            bike(request.origin, boarding, start, 120),
            .fold(TransitionLeg(place: boarding, startTime: start.addingTimeInterval(120), endTime: start.addingTimeInterval(300))),
            transit(boarding, alighting, start.addingTimeInterval(300), 600),
            .unfold(TransitionLeg(place: alighting, startTime: start.addingTimeInterval(900), endTime: start.addingTimeInterval(1_020))),
            bike(alighting, request.destination, start.addingTimeInterval(1_020), 600)
        ])
    }

    func testTransferSeedsKeepOuterWalkingModeAndSeparateCacheKeys() throws {
        let original = base()
        let footLegs = original.legs.map { leg -> JourneyLeg in
            if case .bike(let movement) = leg { return .walk(movement) }
            return leg
        }
        let foot = journey(footLegs)
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        let bikeSeed = try XCTUnwrap(BikeTransferComposer.seeds([original], request: request, settings: .defaults, depth: 0).first)
        let footSeed = try XCTUnwrap(BikeTransferComposer.seeds([foot], request: request, settings: .defaults, depth: 0).first)
        XCTAssertEqual(bikeSeed.outerMode, .bike)
        XCTAssertEqual(footSeed.outerMode, .walk)
        XCTAssertNotEqual(bikeSeed.key, footSeed.key)
        let walkStart = journey([.walk(MovementLeg(from: origin, to: stop, startTime: date,
            endTime: date.addingTimeInterval(60), distance: 80, coordinates: [origin.coordinate, stop.coordinate], maneuvers: [])),
            transit(stop, destination, date.addingTimeInterval(300), 600)])
        let backwards = RouteRequest(origin: origin, destination: destination, timing: .arriveBy(date.addingTimeInterval(900)))
        let backwardSeed = try XCTUnwrap(BikeTransferComposer.seeds([walkStart], request: backwards, settings: .defaults, depth: 0).first)
        XCTAssertEqual(backwardSeed.outerMode, .walk)
    }

    func testForwardCompositionReservesFoldUnfoldAndBufferExactlyOnce() throws {
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        let seed = try XCTUnwrap(BikeTransferComposer.seeds([base()], request: request, settings: .defaults, depth: 0).first)
        let result = try XCTUnwrap(BikeTransferComposer.compose(seed, with: part(seed.request), request: request, settings: .defaults))
        XCTAssertEqual(result.bikeTransferCount, 1)
        XCTAssertEqual(Array(result.legs.prefix(6)).map(\.kind), [.transit, .unfold, .bike, .fold, .wait, .transit])
        XCTAssertEqual(result.legs[1].startTime, date.addingTimeInterval(600))
        XCTAssertEqual(result.legs[1].endTime, date.addingTimeInterval(780))
        XCTAssertEqual(result.legs[2].startTime, date.addingTimeInterval(780))
        XCTAssertEqual(result.legs[4].endTime.timeIntervalSince(result.legs[4].startTime), 180)
        XCTAssertEqual(result.legs[5].startTime, date.addingTimeInterval(1_260))
        XCTAssertEqual(result.origin, origin)
        XCTAssertEqual(result.destination, destination)
    }

    func testBackwardCompositionHonorsArrivalDeadline() throws {
        let original = journey([transit(stop, destination, date.addingTimeInterval(2_400), 600)])
        let request = RouteRequest(origin: origin, destination: destination, timing: .arriveBy(date.addingTimeInterval(3_000)))
        let seed = try XCTUnwrap(BikeTransferComposer.seeds([original], request: request, settings: .defaults, depth: 0).first)
        let result = try XCTUnwrap(BikeTransferComposer.compose(seed, with: part(seed.request), request: request, settings: .defaults))
        XCTAssertEqual(result.arrival, request.timing.date)
        XCTAssertEqual(result.bikeTransferCount, 1)
        XCTAssertEqual(Array(result.legs.suffix(4)).map(\.kind), [.bike, .fold, .wait, .transit])
        var settings = NavigationSettings.defaults
        settings.maxCyclingMinutes = 9
        XCTAssertNil(BikeTransferComposer.compose(seed, with: part(seed.request), request: request, settings: settings))
    }

    func testLimitsAndInvalidConnectionsAreRejected() throws {
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        let seed = try XCTUnwrap(BikeTransferComposer.seeds([base()], request: request, settings: .defaults, depth: 0).first)
        let onward = part(seed.request)
        var settings = NavigationSettings.defaults
        settings.maxCyclingMinutes = 1
        XCTAssertNil(BikeTransferComposer.compose(seed, with: onward, request: request, settings: settings))
        settings.maxCyclingMinutes = 2
        XCTAssertNotNil(BikeTransferComposer.compose(seed, with: onward, request: request, settings: settings))
        settings.maxBikeTransfers = 0
        XCTAssertNil(BikeTransferComposer.compose(seed, with: onward, request: request, settings: settings))
        let tooEarly = journey(onward.legs.map { $0.shifted(by: -60) })
        XCTAssertNil(BikeTransferComposer.compose(seed, with: tooEarly, request: request, settings: .defaults))
    }

    func testSearchFindsThreeConsecutiveBikeTransfersWithinBounds() async {
        let collector = UpdateCollector()
        let calls = RequestCounter()
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 3
        let search = BikeTransferSearch { [self] request, _, _ in
            await calls.increment()
            return [part(request)]
        }
        await search.run(base: [base()], request: request, settings: settings) { collector.append($0) }
        let updates = collector.values
        XCTAssertTrue(updates.last?.journeys.contains { $0.bikeTransferCount == 3 } == true)
        XCTAssertTrue(updates.flatMap(\.journeys).allSatisfy { $0.bikeTransferCount <= 3 })
        let count = await calls.count
        XCTAssertLessThanOrEqual(count, 12)
        XCTAssertEqual(updates.last?.status, .complete)
    }

    func testExtraSearchCarriesPartialGeometryAndTimeoutCauses() async {
        let collector = UpdateCollector()
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        var search = BikeTransferSearch { _, _, _ in [] }
        search.fetchUpdate = { _, _, _ in
            JourneyOptionsUpdate(journeys: [], status: .partial, issues: [.invalidRouteGeometry, .timedOut])
        }
        await search.run(base: [base()], request: request, settings: .defaults) { collector.append($0) }
        XCTAssertEqual(collector.values.last?.issues, [.invalidRouteGeometry, .timedOut])
        XCTAssertEqual(collector.values.last?.status, .partial)
        XCTAssertEqual(collector.values.last?.journeys.map(\.id), ["base"])
    }

    func testDisabledSearchAndDeadlineKeepBaseResults() async {
        let calls = RequestCounter()
        let collector = UpdateCollector()
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let search = BikeTransferSearch(fetch: { _, _, _ in
            await calls.increment()
            try await Task.sleep(for: .seconds(5))
            return []
        }, budget: .milliseconds(10))
        await search.run(base: [base()], request: request, settings: settings) { collector.append($0) }
        let disabledCalls = await calls.count
        XCTAssertEqual(disabledCalls, 0)
        settings.maxBikeTransfers = 2
        await search.run(base: [base()], request: request, settings: settings) { collector.append($0) }
        XCTAssertEqual(collector.values.last?.status, .partial)
        XCTAssertEqual(collector.values.last?.issues, [.searchDeadline])
        XCTAssertEqual(collector.values.last?.journeys.map(\.id), ["base"])
    }

    func testLiveDelayDetectsMissedBikeConnectionAndPreservesLegIDs() throws {
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        let seed = try XCTUnwrap(BikeTransferComposer.seeds([base()], request: request, settings: .defaults, depth: 0).first)
        let result = try XCTUnwrap(BikeTransferComposer.compose(seed, with: part(seed.request), request: request, settings: .defaults))
        guard case .transit(let first) = result.legs[0] else { return XCTFail() }
        let update = TransitUpdate(departure: first.startTime, arrival: first.endTime.addingTimeInterval(60), isRealtime: true, isCancelled: false)
        let updated = TransitJourneyUpdater.apply([first.id: .updated(update)], to: result, from: 0, now: date)
        XCTAssertEqual(updated.legs.map(\.id), result.legs.map(\.id))
        XCTAssertNotNil(TransitJourneyUpdater.disruption(in: updated, from: 0, now: date))
        XCTAssertNil(TransitJourneyUpdater.disruption(in: result, from: 0, now: date))
    }

    @MainActor
    func testProgressiveResultsKeepExplicitSelectionAndThreeOptions() async throws {
        let initial = base()
        let planner = ProgressiveBikePlanner(initial: [initial])
        let container = try ModelContainer(for: StoredPlace.self, StoredJourney.self, StoredSettings.self, StoredActiveJourney.self,
                                           configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = SwiftDataJourneyStore(container: container)
        let location = CLLocation(coordinate: origin.coordinate.clCoordinate, altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: Date())
        let model = try AppModel(planner: planner, store: store, location: LocationService(), guidance: GuidanceService(), planningLocationProvider: { location })
        await model.planToDestination(destination)
        XCTAssertEqual(model.journey?.id, initial.id)
        XCTAssertEqual(model.planningState, .ready)
        XCTAssertEqual(model.bikeTransferSearchStatus, .searching)
        model.selectJourney(at: 0)
        let alternatives = (0..<3).map { i in
            journey([transit(origin, destination, date, Double(100 + i))], id: "better-\(i)")
        }
        planner.emit(JourneyOptionsUpdate(journeys: alternatives, status: .complete))
        for _ in 0..<100 where model.bikeTransferSearchStatus == .searching { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.journey?.id, initial.id)
        XCTAssertEqual(model.journeyOptions.count, 3)
        XCTAssertTrue(model.journeyOptions.contains { $0.id == initial.id })
        XCTAssertEqual(try store.loadActiveJourney()?.id, initial.id)
        planner.finish()
        model.discardRoute()
    }

    @MainActor
    func testNavigationStartAndCloseCancelProgressiveUpdates() async throws {
        for startNavigation in [false, true] {
            let initial = base()
            let planner = ProgressiveBikePlanner(initial: [initial])
            let container = try ModelContainer(for: StoredPlace.self, StoredJourney.self, StoredSettings.self, StoredActiveJourney.self,
                                               configurations: ModelConfiguration(isStoredInMemoryOnly: true))
            let store = SwiftDataJourneyStore(container: container)
            var settings = NavigationSettings.defaults
            settings.audioEnabled = false
            settings.hapticsEnabled = false
            try store.saveSettings(settings)
            let current = CLLocation(coordinate: origin.coordinate.clCoordinate, altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: Date())
            let location = LocationService()
            let model = try AppModel(planner: planner, store: store, location: location, guidance: GuidanceService(), planningLocationProvider: { current })
            await model.planToDestination(destination)
            if startNavigation {
                location.locationManager(CLLocationManager(), didUpdateLocations: [current])
                await model.startNavigation()
                XCTAssertNotNil(model.navigation)
            } else { model.discardRoute() }
            let expected = model.journey
            let progress = try store.loadActiveSnapshot()?.progress
            planner.emit(JourneyOptionsUpdate(journeys: [journey([transit(origin, destination, date, 50)], id: "late")], status: .complete))
            try await Task.sleep(for: .milliseconds(30))
            XCTAssertEqual(model.journey?.id, expected?.id)
            XCTAssertEqual(try store.loadActiveSnapshot()?.progress, progress)
            XCTAssertTrue(planner.cancelled)
            model.stopNavigation(discardRoute: true)
        }
    }

    func testWaitingBufferIsNotChargedTwiceAndMovesWithDelayedDeparture() throws {
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        let seed = try XCTUnwrap(BikeTransferComposer.seeds([base()], request: request, settings: .defaults, depth: 0).first)
        let result = try XCTUnwrap(BikeTransferComposer.compose(seed, with: part(seed.request), request: request, settings: .defaults))
        let now = date.addingTimeInterval(1_100)
        var refreshed = result.legs
        for i in refreshed.indices {
            if case .transit(var leg) = refreshed[i] { leg.lastUpdatedAt = now; refreshed[i] = .transit(leg) }
        }
        let fresh = result.replacingLegs(refreshed)
        XCTAssertNil(TransitJourneyUpdater.disruption(in: fresh, from: 4, now: now))
        guard case .transit(let boarding) = fresh.legs[5] else { return XCTFail() }
        let update = TransitUpdate(departure: boarding.startTime.addingTimeInterval(120), arrival: boarding.endTime.addingTimeInterval(120), isRealtime: true, isCancelled: false)
        let delayed = TransitJourneyUpdater.apply([boarding.id: .updated(update)], to: fresh, from: 4, now: now)
        XCTAssertEqual(delayed.legs[4].endTime, update.departure)
        XCTAssertEqual(delayed.legs[4].id, fresh.legs[4].id)
        XCTAssertNil(TransitJourneyUpdater.disruption(in: delayed, from: 4, now: now))
    }

    @MainActor
    func testLegacySettingsAndStoredValuesPreserveDefaults() throws {
        let decoded = try JSONDecoder().decode(NavigationSettings.self, from: Data("{\"foldDuration\":240,\"audioEnabled\":false}".utf8))
        XCTAssertEqual(decoded.foldDuration, 240)
        XCTAssertFalse(decoded.audioEnabled)
        XCTAssertEqual(decoded.maxBikeTransfers, 2)
        XCTAssertEqual(decoded.maxCyclingMinutes, 30)
        let stored = StoredSettings()
        stored.maxBikeTransfers = nil
        stored.maxCyclingMinutes = nil
        XCTAssertEqual(stored.value.maxBikeTransfers, 2)
        var settings = stored.value
        settings.maxBikeTransfers = 3
        settings.maxCyclingMinutes = 60
        stored.update(settings)
        XCTAssertEqual(stored.value, settings)
        XCTAssertEqual(try JSONDecoder().decode(NavigationSettings.self, from: JSONEncoder().encode(settings)), settings)
    }
}

private actor RequestCounter {
    var count = 0
    func increment() { count += 1 }
}

private final class UpdateCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var updates: [JourneyOptionsUpdate] = []
    var values: [JourneyOptionsUpdate] { lock.withLock { updates } }
    func append(_ update: JourneyOptionsUpdate) { lock.withLock { updates.append(update) } }
}

private final class ProgressiveBikePlanner: JourneyPlanning, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<JourneyOptionsUpdate, Error>.Continuation?
    private var wasCancelled = false
    let initial: [Journey]
    init(initial: [Journey]) { self.initial = initial }
    var cancelled: Bool { lock.withLock { wasCancelled } }
    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey { initial[0] }
    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey { initial[0] }
    func alternativeUpdates(_ request: RouteRequest, settings: NavigationSettings) -> AsyncThrowingStream<JourneyOptionsUpdate, Error> {
        AsyncThrowingStream { continuation in
            lock.withLock { self.continuation = continuation }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                lock.withLock { wasCancelled = true }
            }
            continuation.yield(JourneyOptionsUpdate(journeys: initial, status: .searching))
        }
    }
    func emit(_ update: JourneyOptionsUpdate) { lock.withLock { continuation }?.yield(update) }
    func finish() { lock.withLock { continuation }?.finish() }
}
