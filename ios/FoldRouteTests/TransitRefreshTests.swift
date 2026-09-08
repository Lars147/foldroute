import CoreLocation
import Foundation
import SwiftData
import XCTest
@testable import FoldRoute

final class TransitRefreshTests: XCTestCase, @unchecked Sendable {
    override func tearDown() { MockURLProtocol.handler = nil; super.tearDown() }

    private let now = Date(timeIntervalSince1970: 2_000_000_000)
    private var a: Place { Place(name: "A", coordinate: Coordinate(latitude: 48.14, longitude: 11.58)) }
    private var b: Place { Place(name: "B", coordinate: Coordinate(latitude: 48.15, longitude: 11.59)) }

    private func transit(trip: String = "trip-1", offset: TimeInterval = 0) -> TransitLeg {
        let start = now.addingTimeInterval(offset)
        let end = start.addingTimeInterval(600)
        return TransitLeg(
            from: a, to: b, startTime: start, endTime: end, mode: "SUBWAY", line: "U4",
            headsign: "B", agency: "MVG", departurePlatform: "1", arrivalPlatform: "2",
            isRealtime: true, isCancelled: false, coordinates: [a.coordinate, b.coordinate],
            reference: TransitReference(tripID: trip, fromID: "a", toID: "b", scheduledDeparture: start, scheduledArrival: end),
            lastUpdatedAt: now
        )
    }

    private func journey(_ legs: [JourneyLeg]) -> Journey {
        Journey(id: "refresh-test", origin: a, destination: b, departure: legs.first!.startTime,
                arrival: legs.last!.endTime, legs: legs, transfers: 1, isDirect: false, score: 0)
    }

    private func walk(start: Date, duration: TimeInterval = 240) -> JourneyLeg {
        .walk(MovementLeg(from: b, to: a, startTime: start, endTime: start.addingTimeInterval(duration),
                          distance: 100, coordinates: [b.coordinate, a.coordinate], maneuvers: []))
    }

    private func update(_ leg: TransitLeg, delay: TimeInterval = 0, cancelled: Bool = false) -> TransitUpdate {
        TransitUpdate(departure: leg.startTime.addingTimeInterval(delay), arrival: leg.endTime.addingTimeInterval(delay),
                      departurePlatform: "7", arrivalPlatform: "8", isRealtime: true, isCancelled: cancelled)
    }

    private func tripJSON(_ leg: TransitLeg, delay: TimeInterval = 120, extraStops: [[String: Any]] = [], cancelled: Bool = false) throws -> Data {
        let formatter = ISO8601DateFormatter()
        func date(_ value: Date) -> String { formatter.string(from: value) }
        let from: [String: Any] = ["stopId": "a", "scheduledDeparture": date(leg.startTime),
                                   "departure": date(leg.startTime.addingTimeInterval(delay)), "track": "7"]
        let to: [String: Any] = ["stopId": "b", "scheduledArrival": date(leg.endTime),
                                 "arrival": date(leg.endTime.addingTimeInterval(delay)), "track": "8"]
        return try JSONSerialization.data(withJSONObject: ["legs": [["from": from, "to": to,
            "realTime": true, "cancelled": cancelled, "intermediateStops": extraStops]]])
    }

    private func decode(_ data: Data) throws -> RefreshedTransitTrip {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(RefreshedTransitTrip.self, from: data)
    }

    func testTripMatchingUsesScheduledEventForRepeatedStopsAndRejectsAmbiguity() throws {
        let leg = transit()
        let date = ISO8601DateFormatter().string(from: leg.startTime.addingTimeInterval(300))
        let result = try decode(tripJSON(leg, extraStops: [["stopId": "a", "scheduledDeparture": date]]))
        let matched = try XCTUnwrap(result.update(for: leg.reference!))
        XCTAssertEqual(matched.departure, leg.startTime.addingTimeInterval(120))
        XCTAssertEqual(matched.arrivalPlatform, "8")
        let duplicate = ISO8601DateFormatter().string(from: leg.startTime)
        let ambiguous = try decode(tripJSON(leg, extraStops: [["stopId": "a", "scheduledDeparture": duplicate]]))
        XCTAssertNil(ambiguous.update(for: leg.reference!))
        let cancelled = try decode(tripJSON(leg, cancelled: true))
        XCTAssertTrue(try XCTUnwrap(cancelled.update(for: leg.reference!)).isCancelled)
    }

    func testTripRefreshGroupsSameTripAndPreservesPartialSuccess() async throws {
        let first = transit(trip: "a-trip")
        var duplicate = transit(trip: "a-trip")
        duplicate.departurePlatform = "4"
        let second = transit(trip: "z-trip")
        let payload = try tripJSON(first)
        let recorder = RequestRecorder()
        MockURLProtocol.handler = { request in
            recorder.append(request)
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            let id = query.first { $0.name == "tripId" }!.value!
            XCTAssertEqual(request.url?.path, "/api/v6/trip")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "User-Agent"))
            let status = id == "a-trip" ? 200 : 503
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                    headerFields: status == 503 ? ["Retry-After": "600"] : [:])!, payload)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = TransitousClient(session: URLSession(configuration: config))
        let results = await client.refresh([first, duplicate, second])
        XCTAssertEqual(recorder.requests.count, 2)
        guard case .updated(let value) = results[first.id] else { return XCTFail("First trip should succeed") }
        XCTAssertEqual(value.departurePlatform, "7")
        guard case .updated = results[duplicate.id] else { return XCTFail("Same trip should share response") }
        guard case .failed(let retry) = results[second.id] else { return XCTFail("Second trip should retain retry information") }
        XCTAssertEqual(retry, 600)
    }

    func testPlanningRetainsTripAndScheduledStopReferences() async throws {
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: TransitousFixtures.multimodal) as? [String: Any])
        var itineraries = payload["itineraries"] as! [[String: Any]]
        var legs = itineraries[0]["legs"] as! [[String: Any]]
        let index = legs.firstIndex { $0["mode"] as? String == "SUBWAY" }!
        legs[index]["tripId"] = "saved-trip"
        legs[index]["scheduledStartTime"] = legs[index]["startTime"]
        legs[index]["scheduledEndTime"] = legs[index]["endTime"]
        var from = legs[index]["from"] as! [String: Any]
        var to = legs[index]["to"] as! [String: Any]
        from["stopId"] = "boarding"
        to["stopId"] = "alighting"
        legs[index]["from"] = from
        legs[index]["to"] = to
        itineraries[0]["legs"] = legs
        payload["itineraries"] = itineraries
        let data = try JSONSerialization.data(withJSONObject: payload)
        MockURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let options = try await TransitousClient(session: URLSession(configuration: config)).planAlternatives(
            RouteRequest(origin: a, destination: b, timing: .leaveNow), settings: quietSettings
        )
        let leg = try XCTUnwrap(options.flatMap { $0.remainingTransit(from: 0) }.first)
        XCTAssertEqual(leg.reference?.tripID, "saved-trip")
        XCTAssertEqual(leg.reference?.fromID, "boarding")
        XCTAssertEqual(leg.reference?.toID, "alighting")
        XCTAssertEqual(leg.reference?.scheduledDeparture, leg.startTime)
        XCTAssertNotNil(leg.lastUpdatedAt)
    }

    func testRealtimePlatformChangeIsNotOverwrittenByLegacyPlatformCorrection() async throws {
        var leg = transit()
        let stopID = "de-DELFI_de:09162:10:45:85"
        leg.reference = TransitReference(tripID: "trip-1", fromID: stopID, toID: "b",
                                         scheduledDeparture: leg.startTime, scheduledArrival: leg.endTime)
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: tripJSON(leg)) as? [String: Any])
        var legs = payload["legs"] as! [[String: Any]]
        var from = legs[0]["from"] as! [String: Any]
        from["stopId"] = stopID
        from["track"] = "7"
        legs[0]["from"] = from
        payload["legs"] = legs
        let data = try JSONSerialization.data(withJSONObject: payload)
        MockURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let result = await TransitousClient(session: URLSession(configuration: config)).refresh([leg])
        guard case .updated(let update) = result[leg.id] else { return XCTFail("Expected update") }
        XCTAssertEqual(update.departurePlatform, "7")
    }

    @MainActor
    func testWalkingArrivalDoesNotAutomaticallyEnterCancelledTrain() {
        var leg = transit()
        leg.isCancelled = true
        let movement = walk(start: now)
        let engine = NavigationEngine(journey: journey([movement, .transit(leg)]), settings: quietSettings, guidance: GuidanceService())
        engine.start()
        engine.update(location: CLLocation(coordinate: a.coordinate.clCoordinate, altitude: 0,
                                          horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: now))
        XCTAssertEqual(engine.currentLegIndex, 0)
        engine.advance()
        XCTAssertEqual(engine.currentLegIndex, 1)
    }

    func testMissingReferenceAndNotFoundAreUnavailableNotCancelled() async throws {
        var legacy = transit()
        legacy.reference = nil
        let valid = transit()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }
        let results = await TransitousClient(session: URLSession(configuration: config)).refresh([legacy, valid])
        guard case .unavailable = results[legacy.id], case .unavailable = results[valid.id] else { return XCTFail("Expected unavailable") }
        let updated = TransitJourneyUpdater.apply(results, to: journey([.transit(legacy), .transit(valid)]), from: 0, now: now)
        XCTAssertTrue(updated.remainingTransit(from: 0).allSatisfy { !$0.isCancelled })
    }

    @MainActor
    func testRefreshPreservesProgressAndCompletedLegsWhileReflowingRemainingSteps() throws {
        let first = transit()
        let second = transit(trip: "trip-2", offset: 1_000)
        let route = journey([.transit(first), walk(start: first.endTime), .transit(second),
                             .unfold(TransitionLeg(place: b, startTime: second.endTime, endTime: second.endTime.addingTimeInterval(180)))])
        let engine = NavigationEngine(journey: route, settings: quietSettings, guidance: GuidanceService())
        engine.start(progress: NavigationProgress(legIndex: 1, maneuverIndex: 0))
        let updated = TransitJourneyUpdater.apply([first.id: .updated(update(first, delay: 600)), second.id: .updated(update(second, delay: 300))], to: route, from: 1, now: now)
        engine.applyTransitJourney(updated)
        XCTAssertEqual(engine.currentLegIndex, 1)
        XCTAssertEqual(engine.currentManeuverIndex, 0)
        XCTAssertEqual(updated.legs[0], route.legs[0])
        XCTAssertEqual(updated.legs[1], route.legs[1])
        XCTAssertEqual(updated.legs.map(\.id), route.legs.map(\.id))
        XCTAssertEqual(updated.legs[3].startTime, second.endTime.addingTimeInterval(300))
        XCTAssertEqual(updated.arrival, route.arrival.addingTimeInterval(300))
    }

    func testConnectionChecksDelayEarlierDepartureAndExistingWalkingBuffer() {
        let first = transit()
        let second = transit(trip: "trip-2", offset: 900)
        let route = journey([.transit(first), walk(start: first.endTime), .transit(second)])
        XCTAssertNil(TransitJourneyUpdater.disruption(in: route, from: 0, now: now))
        let delayed = TransitJourneyUpdater.apply([first.id: .updated(update(first, delay: 120))], to: route, from: 0, now: now)
        XCTAssertNotNil(TransitJourneyUpdater.disruption(in: delayed, from: 0, now: now))
        let earlier = TransitJourneyUpdater.apply([second.id: .updated(update(second, delay: -120))], to: route, from: 0, now: now)
        XCTAssertNotNil(TransitJourneyUpdater.disruption(in: earlier, from: 0, now: now))
        let cancelled = TransitJourneyUpdater.apply([second.id: .updated(update(second, cancelled: true))], to: route, from: 0, now: now)
        XCTAssertTrue(TransitJourneyUpdater.disruption(in: cancelled, from: 0, now: now)!.id.hasPrefix("cancelled-"))
        let partialFailure = TransitJourneyUpdater.apply([first.id: .failed(retryAfter: nil)], to: cancelled, from: 0, now: now)
        XCTAssertTrue(TransitJourneyUpdater.disruption(in: partialFailure, from: 0, now: now)!.id.hasPrefix("cancelled-"))
    }

    @MainActor
    func testStaleFailedOrCancelledTransitNeverAutomaticallyEndsButManualStepWorks() {
        for failure in [TransitRefreshFailure.network, .unavailable] {
            var leg = transit()
            leg.refreshFailure = failure
            let engine = NavigationEngine(journey: journey([.transit(leg)]), settings: quietSettings, guidance: GuidanceService())
            engine.start()
            engine.tick(now: leg.endTime.addingTimeInterval(10))
            XCTAssertNotEqual(engine.phase, .arrived)
            engine.advance()
            XCTAssertEqual(engine.phase, .arrived)
        }
        var leg = transit()
        leg.lastUpdatedAt = now.addingTimeInterval(-121)
        XCTAssertFalse(TransitRefreshPolicy.canUseTimes(leg, now: now))
        leg.lastUpdatedAt = now
        leg.isCancelled = true
        XCTAssertFalse(TransitRefreshPolicy.canUseTimes(leg, now: now))
    }

    func testReminderUpdatesReplaceTimesAndExcludeCompletedOrFailedTrips() {
        let first = transit(offset: 600)
        let second = transit(trip: "trip-2", offset: 1_800)
        let route = journey([.transit(first), .transit(second)])
        let before = TransitReminder.remaining(in: route, from: 0, now: now)
        XCTAssertEqual(before.count, 3) // current trip has only an alighting reminder
        let updated = TransitJourneyUpdater.apply([second.id: .updated(update(second, delay: 180))], to: route, from: 0, now: now)
        let after = TransitReminder.remaining(in: updated, from: 0, now: now)
        XCTAssertEqual(before.map(\.id), after.map(\.id))
        XCTAssertEqual(after.last!.date, before.last!.date.addingTimeInterval(180))
        let failed = TransitJourneyUpdater.apply([second.id: .failed(retryAfter: nil)], to: updated, from: 1, now: now)
        XCTAssertTrue(TransitReminder.remaining(in: failed, from: 1, now: now).isEmpty)
    }

    func testRetryPolicyHonorsServerDelayAndCapsOrdinaryBackoff() {
        XCTAssertEqual(TransitRefreshPolicy.retryDelay(failures: 1, retryAfter: nil), 120)
        XCTAssertEqual(TransitRefreshPolicy.retryDelay(failures: 2, retryAfter: nil), 240)
        XCTAssertEqual(TransitRefreshPolicy.retryDelay(failures: 20, retryAfter: nil), 300)
        XCTAssertEqual(TransitRefreshPolicy.retryDelay(failures: 1, retryAfter: 900), 900)
        XCTAssertEqual(TransitRefreshPolicy.retryAfter("120"), 120)
        XCTAssertEqual(TransitRefreshPolicy.retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now: Date(timeIntervalSince1970: 1_445_412_420)), 60)
    }

    private var quietSettings: NavigationSettings {
        var settings = NavigationSettings.defaults
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        return settings
    }

    @MainActor
    private func model(_ route: Journey, refresher: any TransitRefreshing, planner: any JourneyPlanning = RefreshTestPlanner()) throws -> (AppModel, SwiftDataJourneyStore) {
        let container = try ModelContainer(for: StoredPlace.self, StoredJourney.self, StoredSettings.self, StoredActiveJourney.self,
                                           configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = SwiftDataJourneyStore(container: container)
        try store.saveSettings(quietSettings)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: route, progress: NavigationProgress(legIndex: 0, maneuverIndex: 0)))
        return (try AppModel(planner: planner, store: store, location: LocationService(), guidance: GuidanceService(), transitRefresher: refresher), store)
    }

    @MainActor
    func testCoordinatorPersistsUpdatesAndAvoidsEarlyRepeatedCalls() async throws {
        let leg = transit()
        let refresher = RecordingTransitRefresher(results: [leg.id: .updated(update(leg, delay: 180))])
        let (model, store) = try model(journey([.transit(leg)]), refresher: refresher)
        await model.refreshTransit(now: now)
        await model.refreshTransit(now: now.addingTimeInterval(59))
        let firstCount = await refresher.callCount
        XCTAssertEqual(firstCount, 1)
        XCTAssertEqual(try store.loadActiveSnapshot()?.journey.legs.first?.endTime, leg.endTime.addingTimeInterval(180))
        XCTAssertEqual(model.navigation?.currentLegIndex, 0)
        await model.refreshTransit(now: now.addingTimeInterval(61))
        let secondCount = await refresher.callCount
        XCTAssertEqual(secondCount, 2)
        model.stopNavigation()
    }

    @MainActor
    func testCoordinatorRetainsTimesOnFailureAndHonorsRetryAfter() async throws {
        let leg = transit()
        let refresher = RecordingTransitRefresher(results: [leg.id: .failed(retryAfter: 600)])
        let route = journey([.transit(leg)])
        let (model, _) = try model(route, refresher: refresher)
        await model.refreshTransit(now: now)
        await model.refreshTransit(now: now.addingTimeInterval(599))
        let firstCount = await refresher.callCount
        XCTAssertEqual(firstCount, 1)
        XCTAssertEqual(model.journey?.legs.first?.endTime, leg.endTime)
        XCTAssertEqual(model.journey?.remainingTransit(from: 0).first?.refreshFailure, .network)
        await model.refreshTransit(now: now.addingTimeInterval(601))
        let secondCount = await refresher.callCount
        XCTAssertEqual(secondCount, 2)
        model.stopNavigation()
    }

    @MainActor
    func testLateRefreshAfterStopCannotRestoreRoute() async throws {
        let leg = transit()
        let started = expectation(description: "refresh started")
        let refresher = GatedTransitRefresher(started: started)
        let (model, store) = try model(journey([.transit(leg)]), refresher: refresher)
        let task = Task { await model.refreshTransit(now: now) }
        await fulfillment(of: [started], timeout: 3)
        await model.refreshTransit(now: now.addingTimeInterval(61))
        let calls = await refresher.callCount
        XCTAssertEqual(calls, 1)
        model.stopNavigation(discardRoute: true)
        await refresher.release([leg.id: .updated(update(leg, delay: 300))])
        await task.value
        XCTAssertNil(model.navigation)
        XCTAssertNil(model.journey)
        XCTAssertNil(try store.loadActiveSnapshot())
    }

    @MainActor
    func testLateResponseAfterRouteReplacementDoesNotOverwriteSelection() async throws {
        let leg = transit()
        let started = expectation(description: "refresh started")
        let refresher = GatedTransitRefresher(started: started)
        let (model, store) = try model(journey([.transit(leg)]), refresher: refresher)
        let task = Task { await model.refreshTransit(now: now) }
        await fulfillment(of: [started], timeout: 3)
        let replacement = try await RefreshTestPlanner().plan(RouteRequest(origin: a, destination: b, timing: .leaveNow), settings: quietSettings)
        model.navigationAlternative = NavigationAlternative(journey: replacement, progress: NavigationProgress(legIndex: 0, maneuverIndex: 0), sourceLegID: leg.id, issueID: nil)
        model.acceptNavigationAlternative()
        await refresher.release([leg.id: .updated(update(leg, delay: 600))])
        await task.value
        XCTAssertEqual(model.journey?.id, "replacement")
        XCTAssertEqual(try store.loadActiveSnapshot()?.journey.id, "replacement")
        model.stopNavigation()
    }

    @MainActor
    func testAlternativeRequiresConfirmationAndKeepsCurrentTransitUntilAlighting() async throws {
        let first = transit()
        let second = transit(trip: "trip-2", offset: 900)
        let refresher = RecordingTransitRefresher(results: [first.id: .updated(update(first)), second.id: .updated(update(second, cancelled: true))])
        let (model, _) = try model(journey([.transit(first), walk(start: first.endTime), .transit(second)]), refresher: refresher)
        await model.refreshTransit(now: now)
        for _ in 0..<100 where model.navigationAlternative == nil { try await Task.sleep(for: .milliseconds(2)) }
        let candidate = try XCTUnwrap(model.navigationAlternative)
        XCTAssertEqual(model.journey?.id, "refresh-test")
        XCTAssertEqual(candidate.journey.legs.first?.id, first.id)
        XCTAssertEqual(candidate.journey.legs[1].kind, .unfold)
        XCTAssertEqual(candidate.progress.legIndex, 0)
        model.dismissNavigationAlternative()
        XCTAssertNotNil(model.transitDisruption)
        XCTAssertEqual(model.journey?.id, "refresh-test")
        model.navigationAlternative = candidate
        model.acceptNavigationAlternative()
        XCTAssertEqual(model.journey?.id, "replacement")
        XCTAssertEqual(model.navigation?.currentLeg?.id, first.id)
        model.stopNavigation()
    }

    func testLegacyTransitDecodesWithoutRefreshMetadata() throws {
        let leg = transit()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(leg)) as? [String: Any])
        object.removeValue(forKey: "reference")
        object.removeValue(forKey: "lastUpdatedAt")
        object.removeValue(forKey: "refreshFailure")
        let decoded = try JSONDecoder().decode(TransitLeg.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(decoded.reference)
        XCTAssertNil(decoded.lastUpdatedAt)
        XCTAssertEqual(decoded.id, leg.id)
    }
}

private actor RecordingTransitRefresher: TransitRefreshing {
    let results: [UUID: TransitRefreshResult]
    private(set) var callCount = 0
    init(results: [UUID: TransitRefreshResult]) { self.results = results }
    func refresh(_ legs: [TransitLeg]) async -> [UUID: TransitRefreshResult] {
        callCount += 1
        return results
    }
}

private actor GatedTransitRefresher: TransitRefreshing {
    private(set) var callCount = 0
    let started: XCTestExpectation
    private var continuation: CheckedContinuation<[UUID: TransitRefreshResult], Never>?
    init(started: XCTestExpectation) { self.started = started }
    func refresh(_ legs: [TransitLeg]) async -> [UUID: TransitRefreshResult] {
        callCount += 1
        return await withCheckedContinuation { continuation = $0; started.fulfill() }
    }
    func release(_ results: [UUID: TransitRefreshResult]) { continuation?.resume(returning: results); continuation = nil }
}

private struct RefreshTestPlanner: JourneyPlanning {
    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        let start = request.timing.date
        let end = start.addingTimeInterval(600)
        let leg = MovementLeg(from: request.origin, to: request.destination, startTime: start, endTime: end,
                              distance: 1_000, coordinates: [request.origin.coordinate, request.destination.coordinate], maneuvers: [])
        return Journey(id: "replacement", origin: request.origin, destination: request.destination, departure: start,
                       arrival: end, legs: [.bike(leg)], transfers: 0, isDirect: true, score: 0)
    }
    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        try await plan(request, settings: settings)
    }
}
