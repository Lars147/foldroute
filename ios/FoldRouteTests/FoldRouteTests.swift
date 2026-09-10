import CoreLocation
import Foundation
import MapKit
import SwiftData
import XCTest
@testable import FoldRoute

final class FoldRouteTests: XCTestCase, @unchecked Sendable {
    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testNavigationCameraImmediatelyUsesStationaryLocation() throws {
        let now = Date()
        let location = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 48.15, longitude: 11.65), altitude: 0,
                                  horizontalAccuracy: 5, verticalAccuracy: 5, course: -1, speed: 0, timestamp: now)
        var state = NavigationCameraState()
        let input = NavigationCameraInput(location: location, leg: nil, maneuver: nil, fallback: Place.munichCenter.coordinate)
        let target = try XCTUnwrap(state.update(input, now: now))
        XCTAssertEqual(target.coordinate, Coordinate(location.coordinate))
        XCTAssertEqual(target.distance, 600)
    }

    func testNavigationCameraRestoresCurrentManeuverWithoutGPS() throws {
        let current = Coordinate(latitude: 49, longitude: 12)
        let maneuver = Maneuver(direction: .straight, instruction: "Weiter", streetName: "", distance: 100,
                                coordinates: [current, Coordinate(latitude: 49.001, longitude: 12)])
        let input = NavigationCameraInput(location: nil, leg: nil, maneuver: maneuver, fallback: Place.munichCenter.coordinate)
        var state = NavigationCameraState()
        let target = try XCTUnwrap(state.update(input))
        XCTAssertEqual(target.coordinate, current)
        XCTAssertEqual(target.heading, 0, accuracy: 0.01)
    }

    func testNavigationCameraRejectsStaleGPSAndHoldsLastGoodPosition() throws {
        let now = Date()
        let fresh = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 49, longitude: 12), altitude: 0,
                               horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: now)
        let stale = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 50, longitude: 13), altitude: 0,
                               horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: now.addingTimeInterval(-120))
        var input = NavigationCameraInput(location: stale, leg: nil, maneuver: nil, fallback: Place.munichCenter.coordinate)
        var state = NavigationCameraState()
        XCTAssertEqual(state.update(input, now: now)?.coordinate, input.fallback)
        input.location = fresh
        XCTAssertEqual(state.update(input, now: now)?.coordinate, Coordinate(fresh.coordinate))
        input.location = stale
        XCTAssertEqual(state.update(input, now: now)?.coordinate, Coordinate(fresh.coordinate))
        input.location = nil
        XCTAssertEqual(state.update(input, now: now)?.coordinate, Coordinate(fresh.coordinate))
    }

    func testNavigationCameraHoldsHeadingAtRestAndCrossesNorthByShortestAngle() throws {
        let now = Date()
        func sample(course: Double, speed: Double) -> CLLocation {
            CLLocation(coordinate: CLLocationCoordinate2D(latitude: 48.15, longitude: 11.65), altitude: 0,
                       horizontalAccuracy: 5, verticalAccuracy: 5, course: course, speed: speed, timestamp: now)
        }
        var input = NavigationCameraInput(location: sample(course: 359, speed: 4), leg: nil, maneuver: nil, fallback: Place.munichCenter.coordinate)
        var state = NavigationCameraState()
        XCTAssertEqual(state.update(input, now: now)?.heading, 359)
        input.location = sample(course: 180, speed: 0)
        XCTAssertEqual(state.update(input, now: now)?.heading, 359)
        input.location = sample(course: 1, speed: 4)
        XCTAssertEqual(state.update(input, now: now)?.heading, 361)
        XCTAssertEqual(NavigationCameraState.headingDelta(from: 1, to: 359), -2)
    }

    func testNavigationCameraUsesNearestNonzeroRouteSegmentForInitialBearing() throws {
        let start = Coordinate(latitude: 48, longitude: 11)
        let corner = Coordinate(latitude: 48.001, longitude: 11)
        let end = Coordinate(latitude: 48.001, longitude: 11.01)
        var input = NavigationCameraInput(location: nil, leg: nil, maneuver: nil, fallback: end)
        input.coordinates = [start, start, corner, end]
        var state = NavigationCameraState()
        XCTAssertEqual(try XCTUnwrap(state.update(input)).heading, 90, accuracy: 0.01)
    }

    func testNavigationCameraChangesScaleAndRetainsItDuringTransitions() {
        var input = NavigationCameraInput(location: nil, leg: nil, maneuver: nil, fallback: Place.munichCenter.coordinate)
        var state = NavigationCameraState()
        for (kind, distance): (JourneyLegKind, Double) in [(.bike, 600), (.fold, 600), (.transit, 1_500), (.wait, 1_500), (.walk, 350), (.unfold, 350)] {
            input.kind = kind
            XCTAssertEqual(state.update(input)?.distance, distance)
        }
    }

    func testNavigationCameraDoesNotFollowUpdatesWhilePannedAndRecentersOnLatestInput() {
        var input = NavigationCameraInput(location: nil, leg: nil, maneuver: nil, fallback: Place.munichCenter.coordinate)
        var state = NavigationCameraState()
        let original = state.update(input)
        state.pause()
        input.fallback = Coordinate(latitude: 49, longitude: 12)
        input.kind = .transit
        XCTAssertNil(state.update(input))
        XCTAssertEqual(state.target, original)
        XCTAssertFalse(state.isFollowing)
        state.resume()
        XCTAssertEqual(state.update(input)?.coordinate, input.fallback)
        XCTAssertEqual(state.target?.distance, 1_500)
        XCTAssertTrue(state.isFollowing)
    }

    func testNavigationAnchorRemainsInsideVisibleMapAboveLargePanels() {
        let viewport = CGSize(width: 430, height: 900)
        for panelHeight: CGFloat in [300, 500, 650] {
            let insets = MapCameraInsets(top: 130, bottom: panelHeight)
            let anchor = NavigationCameraState.anchor(viewport: viewport, insets: insets)
            XCTAssertEqual(anchor.x, 215)
            XCTAssertGreaterThan(anchor.y, insets.top)
            XCTAssertLessThan(anchor.y, viewport.height - panelHeight)
            XCTAssertEqual((anchor.y - insets.top) / (viewport.height - panelHeight - insets.top), 2.0 / 3.0, accuracy: 0.001)
        }
    }

    func testJourneyPanelRestoresLastOpenSize() {
        var panel = JourneyPanelState()
        XCTAssertEqual(panel.size, .normal)
        panel.set(.expanded)
        panel.set(.collapsed)
        XCTAssertEqual(panel.lastOpenSize, .expanded)
        panel.set(panel.lastOpenSize)
        XCTAssertEqual(panel.size, .expanded)
        panel.set(.collapsed)
        XCTAssertEqual(panel.size, .collapsed)
        XCTAssertEqual(panel.lastOpenSize, .expanded)
    }

    func testJourneyPanelHeightsFitViewportAndSnap() {
        let heights = JourneyPanelHeights(available: 800, summary: 110, actions: 170)
        XCTAssertLessThan(heights.collapsed, heights.normal)
        XCTAssertLessThan(heights.normal, heights.expanded)
        XCTAssertLessThanOrEqual(heights.expanded, 800)
        XCTAssertEqual(heights.nearest(to: -100), .collapsed)
        XCTAssertEqual(heights.nearest(to: heights.normal + 10), .normal)
        XCTAssertEqual(heights.nearest(to: 1000), .expanded)
        let small = JourneyPanelHeights(available: 350, summary: 190, actions: 220)
        XCTAssertLessThanOrEqual(small.collapsed, small.normal)
        XCTAssertLessThanOrEqual(small.normal, small.expanded)
        XCTAssertLessThanOrEqual(small.expanded, 350)
    }

    func testRouteTapDistinguishesBackgroundAndClosestRoute() {
        XCTAssertNil(RoutePolylineHitTester.closestJourney(in: []))
        XCTAssertNil(RoutePolylineHitTester.closestJourney(in: [("route", 23)]))
        XCTAssertEqual(RoutePolylineHitTester.closestJourney(in: [("current", 10), ("alternative", 4)]), "alternative")
        XCTAssertEqual(RoutePolylineHitTester.closestJourney(in: [("current", 0), ("alternative", 0)]), "current")
        XCTAssertEqual(RoutePolylineHitTester.closestJourney(in: [("route", 22)]), "route")
    }

    func testPolylineDecoderUsesRequestedPrecision() throws {
        let coordinates = try PolylineDecoder.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision: 5)

        XCTAssertEqual(coordinates.count, 3)
        XCTAssertEqual(coordinates[0].latitude, 38.5, accuracy: 0.000_001)
        XCTAssertEqual(coordinates[0].longitude, -120.2, accuracy: 0.000_001)
        XCTAssertEqual(coordinates[2].latitude, 43.252, accuracy: 0.000_001)
        XCTAssertEqual(coordinates[2].longitude, -126.453, accuracy: 0.000_001)
    }

    func testRouteCameraFitterCentersRouteAboveBottomPanel() throws {
        let coordinates = [
            Coordinate(latitude: 48.1372, longitude: 11.5665),
            Coordinate(latitude: 48.1325, longitude: 11.6100),
            Coordinate(latitude: 48.1498, longitude: 11.6577)
        ]
        let viewport = CGSize(width: 430, height: 850)
        let insets = MapCameraInsets(top: 64, leading: 24, bottom: 500, trailing: 24)

        let mapRect = try XCTUnwrap(
            RouteCameraFitter.mapRect(
                coordinates: coordinates,
                viewportSize: viewport,
                insets: insets
            )
        )
        let screenPoints = coordinates.map { coordinate -> CGPoint in
            let mapPoint = MKMapPoint(coordinate.clCoordinate)
            return CGPoint(
                x: (mapPoint.x - mapRect.minX) / mapRect.width * Double(viewport.width),
                y: (mapPoint.y - mapRect.minY) / mapRect.height * Double(viewport.height)
            )
        }

        XCTAssertTrue(screenPoints.allSatisfy { $0.x >= insets.leading - 0.5 })
        XCTAssertTrue(screenPoints.allSatisfy { $0.x <= viewport.width - insets.trailing + 0.5 })
        XCTAssertTrue(screenPoints.allSatisfy { $0.y >= insets.top - 0.5 })
        XCTAssertTrue(screenPoints.allSatisfy { $0.y <= viewport.height - insets.bottom + 0.5 })

        let routeCenterY = (
            coordinates.map { MKMapPoint($0.clCoordinate).y }.min()!
                + coordinates.map { MKMapPoint($0.clCoordinate).y }.max()!
        ) / 2
        let routeCenterScreenY = (routeCenterY - mapRect.minY) / mapRect.height * Double(viewport.height)
        let visibleCenterY = Double(insets.top + viewport.height - insets.bottom) / 2
        XCTAssertEqual(routeCenterScreenY, visibleCenterY, accuracy: 0.5)
    }

    func testRouteCameraFitterKeepsUsefulScaleForSinglePoint() throws {
        let coordinate = Coordinate(latitude: 48.1372, longitude: 11.5756)
        let viewport = CGSize(width: 430, height: 850)
        let mapRect = try XCTUnwrap(
            RouteCameraFitter.mapRect(
                coordinates: [coordinate],
                viewportSize: viewport,
                insets: MapCameraInsets(top: 64, leading: 24, bottom: 300, trailing: 24)
            )
        )

        let metersAcross = mapRect.width * MKMetersPerMapPointAtLatitude(coordinate.latitude)
        XCTAssertGreaterThanOrEqual(metersAcross, RouteCameraFitter.minimumRouteDimension)
        XCTAssertNil(
            RouteCameraFitter.mapRect(
                coordinates: [],
                viewportSize: viewport,
                insets: .zero
            )
        )
    }


    func testSelectedRouteCameraFitsEndpointsStopsAndWaypointWithExpandedPanel() throws {
        let start = Place(name: "Start", coordinate: Coordinate(latitude: 48.13, longitude: 11.50))
        let goal = Place(name: "Ziel", coordinate: Coordinate(latitude: 48.18, longitude: 11.70))
        let waypoint = Place(name: "Geplanter Start", coordinate: Coordinate(latitude: 48.12, longitude: 11.52))
        let stopPlace = Place(name: "Zwischenziel", coordinate: Coordinate(latitude: 48.20, longitude: 11.60))
        let stop = RouteStop(place: stopPlace)
        let now = Date()
        let journey = Journey(
            id: "camera", origin: start, destination: goal, waypoint: waypoint,
            departure: now, arrival: now.addingTimeInterval(60),
            legs: [.stop(TransitionLeg(place: stopPlace, startTime: now, endTime: now, stop: stop))],
            transfers: 0, isDirect: false, score: 0
        )
        let viewport = CGSize(width: 390, height: 844)
        // Only 60 points remain for the route; the ordinary fitter assumes at least 120.
        let insets = MapCameraInsets(top: 80, leading: 24, bottom: 704, trailing: 24)
        let rect = try XCTUnwrap(RouteCameraFitter.selectedRouteRect(
            journey: journey, viewportSize: viewport, insets: insets
        ))
        for place in [start, goal, waypoint, stopPlace] {
            let point = MKMapPoint(place.coordinate.clCoordinate)
            let x = (point.x - rect.minX) / rect.width * viewport.width
            let y = (point.y - rect.minY) / rect.height * viewport.height
            XCTAssertGreaterThanOrEqual(x, insets.leading - 0.5)
            XCTAssertLessThanOrEqual(x, viewport.width - insets.trailing + 0.5)
            XCTAssertGreaterThanOrEqual(y, insets.top - 0.5)
            XCTAssertLessThanOrEqual(y, viewport.height - insets.bottom + 0.5)
        }
        XCTAssertNil(RouteCameraFitter.selectedRouteRect(
            journey: journey, viewportSize: viewport,
            insets: MapCameraInsets(top: 80, bottom: 764)
        ))
    }

    func testIdleCameraCentersLocationInsideVisibleMapArea() throws {
        let coordinate = Coordinate(latitude: 48.3705, longitude: 10.8978)
        let viewport = CGSize(width: 430, height: 850)
        let insets = MapCameraInsets(top: 64, leading: 24, bottom: 500, trailing: 24)
        let mapRect = try XCTUnwrap(
            RouteCameraFitter.mapRect(
                coordinates: [coordinate],
                viewportSize: viewport,
                insets: insets,
                minimumContentDimension: 5_000
            )
        )
        let mapPoint = MKMapPoint(coordinate.clCoordinate)
        let screenX = (mapPoint.x - mapRect.minX) / mapRect.width * Double(viewport.width)
        let screenY = (mapPoint.y - mapRect.minY) / mapRect.height * Double(viewport.height)
        let visibleCenterX = Double(insets.leading + viewport.width - insets.trailing) / 2
        let visibleCenterY = Double(insets.top + viewport.height - insets.bottom) / 2

        XCTAssertEqual(screenX, visibleCenterX, accuracy: 0.5)
        XCTAssertEqual(screenY, visibleCenterY, accuracy: 0.5)
    }

    func testRoutePolylineHitTesterMeasuresDistanceToClosestSegment() throws {
        let polylines = [
            [CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 0)],
            [CGPoint(x: 100, y: 100), CGPoint(x: 110, y: 100)]
        ]

        let besideSegment = try XCTUnwrap(
            RoutePolylineHitTester.minimumDistance(
                from: CGPoint(x: 5, y: 4),
                to: polylines
            )
        )
        let beyondEndpoint = try XCTUnwrap(
            RoutePolylineHitTester.minimumDistance(
                from: CGPoint(x: 13, y: 4),
                to: polylines
            )
        )

        XCTAssertEqual(besideSegment, 4, accuracy: 0.001)
        XCTAssertEqual(beyondEndpoint, 5, accuracy: 0.001)
        XCTAssertLessThan(besideSegment, RoutePolylineHitTester.maximumTapDistance)
    }

    func testRoutePolylineHitTesterRejectsMissingSegments() {
        XCTAssertNil(
            RoutePolylineHitTester.minimumDistance(
                from: CGPoint(x: 0, y: 0),
                to: [[], [CGPoint(x: 1, y: 1)]]
            )
        )
    }

    func testMultimodalRouteAddsBikeTransitionsAndBuildsExpectedQueries() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { request in
            queryValue("directModes", in: request) == "BIKE"
                ? TransitousFixtures.empty
                : TransitousFixtures.multimodal
        }

        var settings = NavigationSettings.defaults
        settings.cyclingSpeedKilometersPerHour = 18
        settings.maxBikeTransfers = 0
        let journey = try await client.plan(makeRequest(), settings: settings)

        XCTAssertEqual(journey.id, "multimodal-1|BIKE|BIKE")
        XCTAssertEqual(journey.legs.map(\.kind), [.bike, .fold, .transit, .unfold, .bike])
        XCTAssertEqual(journey.departure, date("2026-09-04T08:00:00Z"))
        XCTAssertEqual(journey.arrival, date("2026-09-04T08:53:00Z"))
        XCTAssertFalse(journey.isDirect)

        guard case .fold(let fold) = journey.legs[1],
              case .unfold(let unfold) = journey.legs[3] else {
            return XCTFail("Expected explicit fold and unfold legs")
        }
        XCTAssertEqual(fold.endTime.timeIntervalSince(fold.startTime), 180)
        XCTAssertEqual(unfold.endTime.timeIntervalSince(unfold.startTime), 180)

        let requests = recorder.requests
        XCTAssertEqual(requests.count, 5)
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "User-Agent") == "FoldRouteTests/1.0 (tests@example.invalid)" })
        XCTAssertTrue(requests.allSatisfy { queryValue("cyclingSpeed", in: $0) == "5.000" })

        let transitRequest = try XCTUnwrap(requests.first { queryValue("preTransitModes", in: $0) == "BIKE" })
        XCTAssertEqual(queryValue("time", in: transitRequest), "2026-09-04T08:03:00Z")
        XCTAssertEqual(queryValue("additionalTransferTime", in: transitRequest), "3")
        XCTAssertEqual(queryValue("requireBikeTransport", in: transitRequest), "false")
        XCTAssertEqual(
            queryValue("transitModes", in: transitRequest),
            "SUBURBAN,SUBWAY,TRAM,BUS,COACH,REGIONAL_RAIL,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL"
        )

        let bikeRequest = try XCTUnwrap(requests.first { queryValue("directModes", in: $0) == "BIKE" })
        XCTAssertEqual(queryValue("time", in: bikeRequest), "2026-09-04T08:00:00Z")
        XCTAssertEqual(queryValue("transitModes", in: bikeRequest), "")
    }

    func testCorrectsDocumentedDelfiPlatformCodesButLeavesUndocumentedOnesUnchanged() async throws {
        let client = makeClient { request in
            queryValue("directModes", in: request) == "BIKE"
                ? TransitousFixtures.empty
                : TransitousFixtures.delfiPlatformCodes
        }

        let journey = try await client.plan(makeRequest(), settings: .defaults)

        guard case .transit(let pasingToOst) = journey.legs[1],
              case .transit(let ostToTrudering) = journey.legs[2] else {
            return XCTFail("Expected two transit legs")
        }

        XCTAssertEqual(pasingToOst.departurePlatform, "5", "Documented Pasing code 85 must be corrected to 5 (mfdz/GTFS-Issues#238)")
        XCTAssertEqual(pasingToOst.arrivalPlatform, "2", "Documented Berg am Laim-style code 82 must be corrected to 2 regardless of the de-DELFI_ source prefix (mfdz/GTFS-Issues#230)")
        XCTAssertEqual(ostToTrudering.departurePlatform, "81", "An undocumented stop_id must not be corrected, even if its code looks similar")
        XCTAssertEqual(ostToTrudering.arrivalPlatform, "3", "A platform with no stopId at all must pass through unchanged")
    }

    func testTransitModeExclusionsAreSentAsExplicitAllowlist() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { request in
            queryValue("directModes", in: request) == "BIKE"
                ? TransitousFixtures.empty
                : TransitousFixtures.multimodal
        }
        var settings = NavigationSettings.defaults
        settings.setTransitMode(.subway, enabled: false)
        settings.setTransitMode(.bus, enabled: false)
        settings.setTransitMode(.longDistanceRail, enabled: false)

        _ = try await client.plan(makeRequest(), settings: settings)

        let transitRequest = try XCTUnwrap(
            recorder.requests.first { queryValue("preTransitModes", in: $0) == "BIKE" }
        )
        XCTAssertEqual(
            queryValue("transitModes", in: transitRequest),
            "SUBURBAN,TRAM,REGIONAL_RAIL"
        )
    }

    func testDisablingEveryTransitModeOnlyRequestsBikeRoute() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { request in
            XCTAssertEqual(queryValue("directModes", in: request), "BIKE")
            return TransitousFixtures.directBike
        }
        var settings = NavigationSettings.defaults
        settings.excludedTransitModes = Set(TransitModePreference.allCases)

        let journey = try await client.plan(makeRequest(), settings: settings)

        XCTAssertTrue(journey.isDirect)
        XCTAssertEqual(recorder.requests.count, 1)
    }

    func testDirectBikeRemainsUsableWhenTransitRequestFails() async throws {
        let client = makeClient { request in
            if queryValue("directModes", in: request) == "BIKE" {
                return TransitousFixtures.directBike
            }
            throw URLError(.cannotConnectToHost)
        }

        let journey = try await client.plan(makeRequest(), settings: .defaults)

        XCTAssertEqual(journey.id, "bike-1")
        XCTAssertEqual(journey.legs.map(\.kind), [.bike])
        XCTAssertTrue(journey.isDirect)
    }

    func testPlanAlternativesDropsTransitWithoutEnoughBenefit() async throws {
        let client = makeClient { request in
            queryValue("directModes", in: request) == "BIKE"
                ? TransitousFixtures.directBike
                : TransitousFixtures.multimodal
        }

        let journeys = try await client.planAlternatives(makeRequest(), settings: NavigationSettings(maxCyclingMinutes: 60))

        XCTAssertEqual(journeys.map(\.id), ["bike-1"])
        XCTAssertTrue(try XCTUnwrap(journeys.first).isDirect)
    }

    func testDedicatedDirectBikeRequestMergesStraightManeuversWithoutLosingEndpoint() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { _ in TransitousFixtures.directBike }

        let journey = try await client.planDirectBike(makeRequest(), settings: .defaults)

        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertEqual(queryValue("directModes", in: recorder.requests[0]), "BIKE")
        guard case .bike(let bike) = journey.legs.first else {
            return XCTFail("Expected direct bike leg")
        }
        XCTAssertEqual(bike.maneuvers.count, 1)
        XCTAssertEqual(bike.maneuvers[0].distance, 300)
        let endpoint = try XCTUnwrap(bike.maneuvers[0].endpoint)
        XCTAssertEqual(endpoint.latitude, 48.1750, accuracy: 0.000_001)
        XCTAssertEqual(endpoint.longitude, 11.6000, accuracy: 0.000_001)
    }

    func testJourneyOptionsAlwaysPutEarliestArrivalFirst() {
        let earliest = makeOptionJourney(
            id: "earliest",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T08:50:00Z",
            line: "U6",
            transfers: 2
        )
        let fewerTransfers = makeOptionJourney(
            id: "fewer-transfers",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T08:52:00Z",
            line: "U5",
            transfers: 0
        )

        let options = JourneyOptionSelector.select(
            from: [fewerTransfers, earliest],
            timing: .departAt(date("2026-09-04T08:00:00Z"))
        )

        XCTAssertEqual(options.map(\.id), ["earliest", "fewer-transfers"])
    }

    func testArriveByJourneyOptionsPutLatestDepartureFirst() {
        let earlierDeparture = makeOptionJourney(
            id: "earlier-departure",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T09:00:00Z",
            line: "U6"
        )
        let laterDeparture = makeOptionJourney(
            id: "later-departure",
            departure: "2026-09-04T08:10:00Z",
            arrival: "2026-09-04T09:00:00Z",
            line: "U5",
            transfers: 2
        )

        let options = JourneyOptionSelector.select(
            from: [earlierDeparture, laterDeparture],
            timing: .arriveBy(date("2026-09-04T09:00:00Z"))
        )

        XCTAssertEqual(options.map(\.id), ["later-departure", "earlier-departure"])
    }

    func testJourneyOptionsPreferDifferentRoutesBeforeTimeVariants() {
        let u6First = makeOptionJourney(
            id: "u6-first",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T08:40:00Z",
            line: "U6"
        )
        let u6Second = makeOptionJourney(
            id: "u6-second",
            departure: "2026-09-04T08:01:00Z",
            arrival: "2026-09-04T08:41:00Z",
            line: "U6"
        )
        let u5 = makeOptionJourney(
            id: "u5",
            departure: "2026-09-04T08:02:00Z",
            arrival: "2026-09-04T08:42:00Z",
            line: "U5"
        )
        let tram = makeOptionJourney(
            id: "tram",
            departure: "2026-09-04T08:03:00Z",
            arrival: "2026-09-04T08:43:00Z",
            line: "Tram 19"
        )

        let options = JourneyOptionSelector.select(
            from: [u6Second, tram, u5, u6First],
            timing: .leaveNow
        )

        XCTAssertEqual(options.map(\.id), ["u6-first", "u5", "tram"])
    }

    func testJourneyOptionsUseTimeVariantOnlyToFillRemainingPage() {
        let u6First = makeOptionJourney(
            id: "u6-first",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T08:40:00Z",
            line: "U6"
        )
        let u6Second = makeOptionJourney(
            id: "u6-second",
            departure: "2026-09-04T08:01:00Z",
            arrival: "2026-09-04T08:41:00Z",
            line: "U6"
        )
        let u5 = makeOptionJourney(
            id: "u5",
            departure: "2026-09-04T08:02:00Z",
            arrival: "2026-09-04T08:42:00Z",
            line: "U5"
        )

        let options = JourneyOptionSelector.select(
            from: [u6Second, u5, u6First],
            timing: .leaveNow
        )

        XCTAssertEqual(options.map(\.id), ["u6-first", "u5", "u6-second"])
    }

    func testJourneyOptionsOnlyIncludeCompetitiveDirectBikeRoute() {
        let transit = makeOptionJourney(
            id: "transit",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T08:50:00Z",
            line: "S4"
        )
        let directAtLimit = makeOptionJourney(
            id: "bike-at-limit",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T09:00:00Z"
        )
        let directTooSlow = makeOptionJourney(
            id: "bike-too-slow",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T09:01:00Z"
        )

        let atLimit = JourneyOptionSelector.select(
            from: [directAtLimit, transit],
            timing: .leaveNow
        )
        let tooSlow = JourneyOptionSelector.select(
            from: [directTooSlow, transit],
            timing: .leaveNow
        )

        XCTAssertEqual(atLimit.map(\.id), ["transit", "bike-at-limit"])
        XCTAssertEqual(tooSlow.map(\.id), ["transit"])
        XCTAssertEqual(
            JourneyOptionSelector.select(from: [directTooSlow], timing: .leaveNow).map(\.id),
            ["bike-too-slow"]
        )
    }

    func testNavigationStartPolicyBlocksBerlinLocationForMunichRoute() {
        let now = Date()
        let berlin = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 52.5200066, longitude: 13.404954),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            timestamp: now
        )
        let munich = Coordinate(latitude: 48.1372, longitude: 11.5756)

        guard case .tooFar(let distance) = NavigationStartPolicy.decision(
            location: berlin,
            origin: munich,
            now: now
        ) else {
            return XCTFail("Expected distant start to be blocked")
        }
        XCTAssertGreaterThan(distance, 500_000)
        XCTAssertLessThan(distance, 510_000)
    }

    func testNavigationStartPolicyRequiresFreshAccurateLocation() {
        let now = Date()
        let origin = makeRequest().origin.coordinate
        let stale = CLLocation(
            coordinate: origin.clCoordinate,
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            timestamp: now.addingTimeInterval(-61)
        )
        let inaccurate = CLLocation(
            coordinate: origin.clCoordinate,
            altitude: 0,
            horizontalAccuracy: 101,
            verticalAccuracy: 5,
            timestamp: now
        )

        XCTAssertEqual(
            NavigationStartPolicy.decision(location: stale, origin: origin, now: now),
            .unavailable
        )
        XCTAssertEqual(
            NavigationStartPolicy.decision(location: inaccurate, origin: origin, now: now),
            .unavailable
        )

        let atStart = CLLocation(
            coordinate: origin.clCoordinate,
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            timestamp: now
        )
        XCTAssertEqual(
            NavigationStartPolicy.decision(location: atStart, origin: origin, now: now),
            .start
        )

        let aboutOneKilometerAway = CLLocation(
            coordinate: CLLocationCoordinate2D(
                latitude: origin.latitude + 0.01,
                longitude: origin.longitude
            ),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            timestamp: now
        )
        guard case .approach = NavigationStartPolicy.decision(
            location: aboutOneKilometerAway,
            origin: origin,
            now: now
        ) else {
            return XCTFail("Expected approach route")
        }
    }

    func testApproachJourneyAddsWaypointAndWaitPhase() throws {
        let onward = makeJourney()
        let current = Place(
            name: "Aktueller Standort",
            coordinate: Coordinate(latitude: 48.12, longitude: 11.55)
        )
        let approachMovement = MovementLeg(
            from: current,
            to: onward.origin,
            startTime: onward.departure.addingTimeInterval(-1_200),
            endTime: onward.departure.addingTimeInterval(-600),
            distance: 2_500,
            coordinates: [current.coordinate, onward.origin.coordinate],
            maneuvers: []
        )
        let approach = Journey(
            id: "approach",
            origin: current,
            destination: onward.origin,
            departure: approachMovement.startTime,
            arrival: approachMovement.endTime,
            legs: [.bike(approachMovement)],
            transfers: 0,
            isDirect: true,
            score: approachMovement.endTime.timeIntervalSince1970
        )

        let combined = try ApproachJourneyComposer.compose(
            approach: approach,
            onward: onward,
            waypoint: onward.origin
        )

        XCTAssertEqual(combined.waypoint, onward.origin)
        XCTAssertEqual(combined.legs.map(\.kind), [.approach, .wait, .bike])
        XCTAssertEqual(combined.bikeDistance, 6_700)
        XCTAssertTrue(
            ApproachJourneyComposer.canKeepConnection(
                approachArrival: approach.arrival,
                onwardDeparture: onward.departure
            )
        )
        XCTAssertFalse(
            ApproachJourneyComposer.canKeepConnection(
                approachArrival: onward.departure,
                onwardDeparture: onward.departure
            )
        )
    }

    func testRateLimitMapsToLocalizedPlannerError() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: nil)!
            return (response, Data())
        }
        let client = TransitousClient(
            session: URLSession(configuration: configuration),
            userAgent: "FoldRouteTests/1.0 (tests@example.invalid)",
            planningPause: PlanningServerPause()
        )

        do {
            _ = try await client.plan(makeRequest(), settings: .defaults)
            XCTFail("Expected rateLimited")
        } catch let error as RoutePlannerError {
            XCTAssertEqual(error, .rateLimited)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    @MainActor
    func testSwiftDataStoreRoundTripsSettingsAndActiveJourney() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: StoredPlace.self,
            StoredJourney.self,
            StoredSettings.self,
            StoredActiveJourney.self,
            configurations: configuration
        )
        let store = SwiftDataJourneyStore(container: container)
        var settings = NavigationSettings.defaults
        settings.foldingDuration = 240
        settings.cyclingSpeedKilometersPerHour = 22
        settings.audioEnabled = false
        settings.excludedTransitModes = [.bus, .subway]

        try store.saveSettings(settings)
        let loadedSettings = try store.loadSettings()
        XCTAssertEqual(loadedSettings, settings)

        let legacySettings = StoredSettings()
        legacySettings.excludedTransitModeIDs = nil
        XCTAssertTrue(legacySettings.value.excludedTransitModes.isEmpty)

        let journey = makeJourney()
        try store.saveActiveJourney(journey)
        XCTAssertEqual(try store.loadActiveJourney(), journey)

        try store.record(journey)
        var history = try container.mainContext.fetch(FetchDescriptor<StoredJourney>())
        let storedJourney = try XCTUnwrap(history.first)
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(storedJourney.originPlace?.name, journey.origin.name)
        XCTAssertEqual(storedJourney.originPlace?.detail, journey.origin.detail)
        XCTAssertEqual(storedJourney.originPlace?.coordinate, journey.origin.coordinate)
        XCTAssertEqual(storedJourney.destinationPlace?.name, journey.destination.name)
        XCTAssertEqual(storedJourney.destinationPlace?.detail, journey.destination.detail)
        XCTAssertEqual(storedJourney.destinationPlace?.coordinate, journey.destination.coordinate)
        XCTAssertTrue(storedJourney.isReplannable)

        try store.updateJourneyNames(
            id: journey.id,
            originName: "Altstadt",
            destinationName: nil
        )
        XCTAssertEqual(storedJourney.originName, "Altstadt")
        XCTAssertEqual(storedJourney.destinationName, journey.destination.name)

        let retainedJourney = makeJourney(id: "retained-journey")
        try store.record(retainedJourney)
        try store.deleteJourney(id: journey.id)
        history = try container.mainContext.fetch(FetchDescriptor<StoredJourney>())
        XCTAssertEqual(history.map(\.id), [retainedJourney.id])

        try store.clearAll()
        XCTAssertNil(try store.loadActiveJourney())
        XCTAssertTrue(try container.mainContext.fetch(FetchDescriptor<StoredJourney>()).isEmpty)
    }

    func testStoredJourneyWithoutCoordinatesCannotBeReplanned() throws {
        let storedJourney = try StoredJourney(journey: makeJourney())

        storedJourney.originLatitude = nil
        storedJourney.originLongitude = nil

        XCTAssertNil(storedJourney.originPlace)
        XCTAssertNotNil(storedJourney.destinationPlace)
        XCTAssertFalse(storedJourney.isReplannable)
    }

    func testCurrentLocationGetsHistoryFallbackName() {
        let currentLocation = Place(
            name: "Aktueller Standort",
            detail: "Genauer Standort",
            coordinate: Coordinate(latitude: 48.1372, longitude: 11.5756)
        )
        let journey = makeJourney(id: "current-location-journey", origin: currentLocation)

        XCTAssertEqual(try StoredJourney(journey: journey).originName, "Startpunkt")
    }

    @MainActor
    func testLegacyCurrentLocationNameGetsResolved() async throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: StoredPlace.self,
            StoredJourney.self,
            StoredSettings.self,
            StoredActiveJourney.self,
            configurations: configuration
        )
        let store = SwiftDataJourneyStore(container: container)
        let currentLocation = Place(
            name: "Aktueller Standort",
            detail: "Genauer Standort",
            coordinate: Coordinate(latitude: 48.1372, longitude: 11.5756)
        )
        let storedJourney = try StoredJourney(
            journey: makeJourney(id: "legacy-current-location", origin: currentLocation)
        )
        storedJourney.originName = "Aktueller Standort"
        container.mainContext.insert(storedJourney)
        try container.mainContext.save()
        let model = try AppModel(
            planner: UnusedJourneyPlanner(),
            store: store,
            location: LocationService(),
            guidance: GuidanceService(),
            historyPlaceNameResolver: StaticHistoryPlaceNameResolver(name: "Altstadt")
        )

        await model.refreshHistoryPlaceNames([storedJourney])

        XCTAssertEqual(storedJourney.originName, "Altstadt")
    }

    func testHistoryPlaceNamePrefersNeighborhoodThenCity() {
        XCTAssertEqual(
            HistoryPlaceNameFormatter.displayName(neighborhood: "Altstadt", city: "München"),
            "Altstadt"
        )
        XCTAssertEqual(
            HistoryPlaceNameFormatter.displayName(neighborhood: nil, city: " München "),
            "München"
        )
        XCTAssertEqual(
            HistoryPlaceNameFormatter.displayName(neighborhood: "München", city: "München"),
            "München"
        )
        XCTAssertNil(HistoryPlaceNameFormatter.displayName(neighborhood: " ", city: nil))
    }

    @MainActor
    func testReplanningUsesStoredDirectionAndLeaveNow() async throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: StoredPlace.self,
            StoredJourney.self,
            StoredSettings.self,
            StoredActiveJourney.self,
            configurations: configuration
        )
        let planner = RecordingJourneyPlanner()
        let model = try AppModel(
            planner: planner,
            store: SwiftDataJourneyStore(container: container),
            location: LocationService(),
            guidance: GuidanceService()
        )
        let storedJourney = try StoredJourney(journey: makeJourney())
        let origin = try XCTUnwrap(storedJourney.originPlace)
        let destination = try XCTUnwrap(storedJourney.destinationPlace)
        model.timingSelection = .arrive

        await model.replan(from: origin, to: destination)

        var requests = await planner.recordedRequests()
        var request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request.origin.name, origin.name)
        XCTAssertEqual(request.origin.coordinate, origin.coordinate)
        XCTAssertEqual(request.destination.name, destination.name)
        XCTAssertEqual(request.destination.coordinate, destination.coordinate)
        assertFrozenNow(request.timing)
        XCTAssertEqual(model.timingSelection, .now)

        await model.replan(from: destination, to: origin)

        requests = await planner.recordedRequests()
        request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request.origin.coordinate, destination.coordinate)
        XCTAssertEqual(request.destination.coordinate, origin.coordinate)
        assertFrozenNow(request.timing)
    }

    @MainActor
    func testPlanningAndSelectingAlternativesUpdatesPersistedActiveJourney() async throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: StoredPlace.self,
            StoredJourney.self,
            StoredSettings.self,
            StoredActiveJourney.self,
            configurations: configuration
        )
        let store = SwiftDataJourneyStore(container: container)
        let first = makeOptionJourney(
            id: "first",
            departure: "2026-09-04T08:00:00Z",
            arrival: "2026-09-04T08:40:00Z",
            line: "U6"
        )
        let second = makeOptionJourney(
            id: "second",
            departure: "2026-09-04T08:02:00Z",
            arrival: "2026-09-04T08:42:00Z",
            line: "U5"
        )
        let model = try AppModel(
            planner: StaticAlternativeJourneyPlanner(journeys: [first, second]),
            store: store,
            location: LocationService(),
            guidance: GuidanceService()
        )
        model.origin = first.origin
        model.destination = first.destination

        await model.planRoute()

        XCTAssertEqual(model.journeyOptions.map(\.id), ["first", "second"])
        XCTAssertEqual(model.journey?.id, "first")
        XCTAssertEqual(model.selectedJourneyIndex, 0)
        XCTAssertEqual(try store.loadActiveJourney()?.id, "first")

        model.selectJourney(at: 1)

        XCTAssertEqual(model.journey?.id, "second")
        XCTAssertEqual(model.selectedJourneyIndex, 1)
        XCTAssertEqual(try store.loadActiveJourney()?.id, "second")

        model.discardRoute()

        XCTAssertTrue(model.journeyOptions.isEmpty)
        XCTAssertNil(model.journey)
        XCTAssertNil(try store.loadActiveJourney())
    }

    @MainActor
    func testSelectingPlacesPersistsDeduplicatedRecentHistory() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: StoredPlace.self,
            StoredJourney.self,
            StoredSettings.self,
            StoredActiveJourney.self,
            configurations: configuration
        )
        let model = try AppModel(
            planner: UnusedJourneyPlanner(),
            store: SwiftDataJourneyStore(container: container),
            location: LocationService(),
            guidance: GuidanceService()
        )
        model.select(
            Place(
                name: "Aktueller Standort",
                detail: "Genauer Standort",
                coordinate: Coordinate(latitude: 48.1372, longitude: 11.5756)
            ),
            for: .origin
        )
        XCTAssertTrue(try container.mainContext.fetch(FetchDescriptor<StoredPlace>()).isEmpty)

        let firstSelection = Place(
            name: "Marienplatz",
            detail: "München",
            coordinate: Coordinate(latitude: 48.1372, longitude: 11.5756)
        )
        let repeatedSelection = Place(
            name: "marienplatz",
            detail: "Altstadt-Lehel, München",
            coordinate: Coordinate(latitude: 48.13721, longitude: 11.57561)
        )

        model.select(firstSelection, for: .origin)
        model.select(repeatedSelection, for: .destination)

        let places = try container.mainContext.fetch(FetchDescriptor<StoredPlace>())
        XCTAssertEqual(places.count, 1)
        XCTAssertEqual(places.first?.detail, repeatedSelection.detail)
        XCTAssertEqual(model.origin, firstSelection)
        XCTAssertEqual(model.destination, repeatedSelection)
    }

    @MainActor
    func testRecentDestinationsExcludeOriginsAndKeepIndependentRecency() throws {
        let store = try makeHomeStore()
        let context = store.container.mainContext
        let legacy = StoredPlace(place: Place.munichCenter)
        context.insert(legacy)
        try context.save()
        let first = makeRequest().origin
        let second = makeRequest().destination
        try store.saveRecentPlace(first, asDestination: true)
        let firstStored = try XCTUnwrap(context.fetch(FetchDescriptor<StoredPlace>()).first { $0.id == first.id })
        firstStored.lastUsedAsDestinationAt = Date(timeIntervalSince1970: 100)
        try store.saveRecentPlace(second, asDestination: true)
        try store.saveRecentPlace(first, asDestination: false)

        let descriptor = FetchDescriptor<StoredPlace>(
            predicate: #Predicate { $0.lastUsedAsDestinationAt != nil },
            sortBy: [SortDescriptor(\.lastUsedAsDestinationAt, order: .reverse)]
        )
        XCTAssertEqual(try context.fetch(descriptor).map(\.id), [second.id, first.id])
        XCTAssertEqual(firstStored.lastUsedAsDestinationAt, Date(timeIntervalSince1970: 100))
        XCTAssertNil(legacy.lastUsedAsDestinationAt)

        let repeated = Place(name: first.name.uppercased(), detail: "Neue Adresse", coordinate: first.coordinate)
        try store.saveRecentPlace(repeated, asDestination: true)
        XCTAssertEqual(try context.fetch(descriptor).map(\.id), [first.id, second.id])
        XCTAssertEqual(try context.fetch(FetchDescriptor<StoredPlace>()).count, 3)
        XCTAssertEqual(firstStored.detail, "Neue Adresse")
    }

    @MainActor
    func testRecentPlaceLimitRetainsReselectedOldestDestination() throws {
        let store = try makeHomeStore()
        let places = (0..<21).map {
            Place(name: "Ziel \($0)", coordinate: Coordinate(latitude: 48.1 + Double($0) * 0.001, longitude: 11.6))
        }
        for place in places.prefix(20) {
            try store.saveRecentPlace(place, asDestination: true)
        }
        try store.saveRecentPlace(places[0], asDestination: true)
        try store.saveRecentPlace(places[20], asDestination: true)
        let stored = try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>())
        XCTAssertEqual(stored.count, 20)
        XCTAssertTrue(stored.contains { $0.id == places[0].id })
        XCTAssertTrue(stored.contains { $0.id == places[20].id })
        XCTAssertFalse(stored.contains { $0.id == places[1].id })
    }

    @MainActor
    func testDestinationPlanningUsesCurrentLocationAndResetsPreviousTiming() async throws {
        let store = try makeHomeStore()
        let planner = RecordingJourneyPlanner()
        let current = usablePlanningLocation()
        let model = try AppModel(
            planner: planner, store: store, location: LocationService(), guidance: GuidanceService(),
            planningLocationProvider: { current }
        )
        model.origin = makeRequest().origin
        model.timingSelection = .arrive
        model.plannedDate = Date().addingTimeInterval(3_600)
        let destination = makeRequest().destination

        await model.planToDestination(destination)

        let requests = await planner.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(request.origin.coordinate, Coordinate(current.coordinate))
        XCTAssertEqual(request.origin.name, "Aktueller Standort")
        XCTAssertEqual(request.destination, destination)
        assertFrozenNow(request.timing)
        XCTAssertEqual(model.timingSelection, .now)
        XCTAssertEqual(model.planningState, .ready)
        XCTAssertNil(model.navigation)
        XCTAssertEqual(try store.loadActiveJourney(), model.journey)

        model.discardRoute()
        XCTAssertNil(model.origin)
        XCTAssertNil(model.destination)
        XCTAssertNil(try store.loadActiveJourney())
        XCTAssertEqual(try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).count, 1)
    }

    @MainActor
    func testMissingOrUnusableLocationKeepsDestinationWithoutRouting() async throws {
        let locations: [CLLocation?] = [nil, usablePlanningLocation(age: 120), usablePlanningLocation(accuracy: 500)]
        for current in locations {
            let store = try makeHomeStore()
            let planner = RecordingJourneyPlanner()
            let model = try AppModel(
                planner: planner, store: store, location: LocationService(), guidance: GuidanceService(),
                planningLocationProvider: { current }
            )
            model.origin = makeRequest().origin
            let destination = makeRequest().destination
            await model.planToDestination(destination)

            XCTAssertNil(model.origin)
            XCTAssertEqual(model.destination, destination)
            guard case .failed = model.planningState else { return XCTFail("Missing location must fail explicitly") }
            let requests = await planner.recordedRequests()
            XCTAssertTrue(requests.isEmpty)
            XCTAssertNil(try store.loadActiveJourney())
            let recent = try XCTUnwrap(store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).first)
            XCTAssertNotNil(recent.lastUsedAsDestinationAt)

            let error = await model.applyRouteAdjustments(
                origin: makeRequest().origin, destination: destination,
                timingSelection: .now, plannedDate: Date()
            )
            XCTAssertNil(error)
            XCTAssertEqual(model.planningState, .ready)
            XCTAssertEqual(model.journey?.destination, destination)
        }
    }

    @MainActor
    func testDestinationSelectionIsIgnoredWhileLocationRequestIsPending() async throws {
        let store = try makeHomeStore()
        let planner = RecordingJourneyPlanner()
        let gate = PlanningLocationGate()
        let started = expectation(description: "Location requested")
        gate.onRequest = { started.fulfill() }
        let model = try AppModel(
            planner: planner, store: store, location: LocationService(), guidance: GuidanceService(),
            planningLocationProvider: { await gate.location() }
        )
        let destination = makeRequest().destination
        let firstTask = Task { await model.planToDestination(destination) }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(model.planningState, .locating)
        await model.planToDestination(Place.munichCenter)
        await model.planRoute()
        XCTAssertEqual(model.destination, destination)
        gate.resolve(usablePlanningLocation())
        await firstTask.value
        let requests = await planner.recordedRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.destination, destination)
    }

    @MainActor
    func testClearingDataInvalidatesPendingDestinationPlanning() async throws {
        let store = try makeHomeStore()
        let planner = RecordingJourneyPlanner()
        let gate = PlanningLocationGate()
        let started = expectation(description: "Location requested")
        gate.onRequest = { started.fulfill() }
        let model = try AppModel(
            planner: planner, store: store, location: LocationService(), guidance: GuidanceService(),
            planningLocationProvider: { await gate.location() }
        )
        let destination = makeRequest().destination
        let task = Task { await model.planToDestination(destination) }
        await fulfillment(of: [started], timeout: 2)
        model.clearLocalData()
        gate.resolve(usablePlanningLocation())
        await task.value
        XCTAssertEqual(model.planningState, .idle)
        XCTAssertNil(model.destination)
        XCTAssertNil(model.journey)
        XCTAssertNil(try store.loadActiveJourney())
        XCTAssertTrue(try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).isEmpty)
        let requests = await planner.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    @MainActor
    func testFailedAdjustmentsPreserveOriginalRouteAndInputs() async throws {
        let store = try makeHomeStore()
        let original = makeJourney()
        let model = try AppModel(
            planner: UnusedJourneyPlanner(), store: store, location: LocationService(), guidance: GuidanceService()
        )
        model.origin = original.origin
        model.destination = original.destination
        model.journey = original
        model.journeyOptions = [original]
        model.planningState = .ready
        try store.saveActiveJourney(original)
        let originalDate = model.plannedDate
        let error = await model.applyRouteAdjustments(
            origin: original.destination, destination: original.origin,
            timingSelection: .arrive, plannedDate: Date().addingTimeInterval(7_200)
        )
        XCTAssertEqual(error, RoutePlannerError.noRoute.localizedDescription)
        XCTAssertEqual(model.journey, original)
        XCTAssertEqual(model.journeyOptions, [original])
        XCTAssertEqual(model.origin, original.origin)
        XCTAssertEqual(model.destination, original.destination)
        XCTAssertEqual(model.timingSelection, .now)
        XCTAssertEqual(model.plannedDate, originalDate)
        XCTAssertEqual(model.planningState, .ready)
        XCTAssertEqual(try store.loadActiveJourney(), original)
    }

    @MainActor
    func testSuccessfulAdjustmentsApplyStartAndDepartureOrArrivalTime() async throws {
        for timing in [TimingSelection.depart, .arrive] {
            let store = try makeHomeStore()
            let original = makeJourney()
            let planner = RecordingJourneyPlanner()
            let model = try AppModel(
                planner: planner, store: store, location: LocationService(), guidance: GuidanceService()
            )
            model.origin = original.origin
            model.destination = original.destination
            model.journey = original
            model.journeyOptions = [original]
            model.planningState = .ready
            try store.saveActiveJourney(original)
            let date = Date().addingTimeInterval(7_200)
            let error = await model.applyRouteAdjustments(
                origin: Place.munichCenter, destination: original.destination,
                timingSelection: timing, plannedDate: date
            )
            XCTAssertNil(error)
            let requests = await planner.recordedRequests()
            XCTAssertEqual(requests.first?.origin, Place.munichCenter)
            XCTAssertEqual(requests.first?.destination, original.destination)
            XCTAssertEqual(requests.first?.timing, timing == .depart ? .departAt(date) : .arriveBy(date))
            XCTAssertEqual(model.origin, Place.munichCenter)
            XCTAssertEqual(model.timingSelection, timing)
            XCTAssertEqual(model.plannedDate, date)
            XCTAssertEqual(model.planningState, .ready)
            XCTAssertEqual(try store.loadActiveJourney(), model.journey)
        }
    }

    @MainActor
    func testRouteAdjustmentsReverseEndpointsAndPreserveSelectedTiming() async throws {
        let store = try makeHomeStore()
        let original = makeJourney()
        let planner = RecordingJourneyPlanner()
        let model = try AppModel(
            planner: planner, store: store, location: LocationService(), guidance: GuidanceService()
        )
        model.origin = original.origin
        model.destination = original.destination
        model.journey = original
        model.journeyOptions = [original]
        model.planningState = .ready
        try store.saveActiveJourney(original)
        let date = Date().addingTimeInterval(7_200)
        let error = await model.applyRouteAdjustments(
            origin: original.destination, destination: original.origin,
            timingSelection: .arrive, plannedDate: date
        )

        XCTAssertNil(error)
        let requests = await planner.recordedRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.origin, original.destination)
        XCTAssertEqual(requests.first?.destination, original.origin)
        XCTAssertEqual(requests.first?.timing, .arriveBy(date))
        XCTAssertEqual(model.origin, original.destination)
        XCTAssertEqual(model.destination, original.origin)
        XCTAssertEqual(try store.loadActiveJourney()?.destination, original.origin)
        let places = try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>())
        XCTAssertNotNil(places.first { $0.id == original.origin.id }?.lastUsedAsDestinationAt)
        XCTAssertNil(places.first { $0.id == original.destination.id }?.lastUsedAsDestinationAt)
    }

    @MainActor
    func testSearchIgnoresOutOfOrderResponses() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let firstStarted = expectation(description: "First search started")
        let secondStarted = expectation(description: "Second search started")
        service.onSearch = { query in
            if query == "Marien" { firstStarted.fulfill() }
            if query == "Garten" { secondStarted.fulfill() }
        }
        search.query = "Marien"
        let first = Task { await search.search() }
        await fulfillment(of: [firstStarted], timeout: 2)
        search.query = "Garten"
        let second = Task { await search.search() }
        await fulfillment(of: [secondStarted], timeout: 2)
        let destination = makeRequest().destination
        service.resolve("Garten", with: .success([destination]))
        await second.value
        service.resolve("Marien", with: .success([Place.munichCenter]))
        await first.value
        XCTAssertEqual(search.results, [PlaceSuggestion(id: destination.id, title: destination.name, subtitle: destination.detail)])
        XCTAssertFalse(search.isSearching)
        XCTAssertNil(search.errorMessage)
    }

    @MainActor
    func testClearingSearchIgnoresLateErrorsAndCancelsDebounce() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let started = expectation(description: "Search started")
        service.onSearch = { _ in started.fulfill() }
        search.query = "Marien"
        let pending = Task { await search.search() }
        await fulfillment(of: [started], timeout: 2)
        search.query = "  "
        await search.search()
        service.resolve("Marien", with: .failure(RoutePlannerError.offline))
        await pending.value
        XCTAssertTrue(search.results.isEmpty)
        XCTAssertNil(search.errorMessage)
        XCTAssertFalse(search.isSearching)

        search.query = "Garten"
        let cancelled = Task { await search.search() }
        cancelled.cancel()
        await cancelled.value
        XCTAssertEqual(service.requestCount, 1)
        XCTAssertFalse(search.isSearching)
        XCTAssertNil(search.errorMessage)
    }

    @MainActor
    func testCancelledSearchDiscardsLateResultsAndStopsSpinner() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let started = expectation(description: "Search started")
        service.onSearch = { _ in started.fulfill() }
        search.query = "Marien"
        let task = Task { await search.search() }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        service.resolve("Marien", with: .success([Place.munichCenter]))
        await task.value
        XCTAssertTrue(search.results.isEmpty)
        XCTAssertFalse(search.isSearching)
        XCTAssertNil(search.errorMessage)
    }

    @MainActor
    func testFavoritesDoNotChangeRecencyAndSurviveSelection() throws {
        let store = try makeHomeStore()
        let place = makeRequest().destination
        try store.setFavorite(place, isFavorite: true)
        let stored = try XCTUnwrap(store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).first)
        XCTAssertTrue(stored.isFavorite)
        XCTAssertNil(stored.lastUsedAt)
        XCTAssertNil(stored.lastUsedAsDestinationAt)
        let repeated = Place(name: place.name.uppercased(), detail: "Neue Adresse", coordinate: place.coordinate)
        try store.saveRecentPlace(repeated, asDestination: true)
        XCTAssertTrue(stored.isFavorite)
        let lastUsed = stored.lastUsedAt
        let lastDestination = stored.lastUsedAsDestinationAt
        XCTAssertNotNil(lastUsed)
        try store.setFavorite(repeated, isFavorite: false)
        XCTAssertEqual(stored.lastUsedAt, lastUsed)
        XCTAssertEqual(stored.lastUsedAsDestinationAt, lastDestination)
        XCTAssertFalse(stored.isFavorite)
        XCTAssertEqual(try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).count, 1)
    }

    @MainActor
    func testUnmarkUnusedFavoriteRemovesPlaceAndCurrentLocationIsExcluded() throws {
        let store = try makeHomeStore()
        let place = makeRequest().destination
        try store.setFavorite(place, isFavorite: true)
        try store.setFavorite(place, isFavorite: false)
        try store.setFavorite(Place(name: "Aktueller Standort", coordinate: place.coordinate), isFavorite: true)
        XCTAssertTrue(try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).isEmpty)
    }

    @MainActor
    func testFavoritesRemainBeyondRecentLimitAndMatchingHasNoFetchCap() throws {
        let store = try makeHomeStore()
        let favorites = (0..<105).map {
            Place(name: "Favorit \($0)", coordinate: Coordinate(latitude: 48 + Double($0) * 0.001, longitude: 11))
        }
        for place in favorites { try store.setFavorite(place, isFavorite: true) }
        for index in 0..<25 {
            try store.saveRecentPlace(Place(name: "Zuletzt \(index)", coordinate: Coordinate(latitude: 49, longitude: 11)), asDestination: true)
        }
        let repeated = Place(name: favorites[0].name.uppercased(), coordinate: favorites[0].coordinate)
        try store.saveRecentPlace(repeated, asDestination: false)
        let places = try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>())
        XCTAssertEqual(places.filter(\.isFavorite).count, 105)
        XCTAssertEqual(places.filter { !$0.isFavorite }.count, 20)
        XCTAssertEqual(places.filter { $0.matches(repeated) }.count, 1)
        try store.clearAll()
        XCTAssertTrue(try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).isEmpty)
    }

    @MainActor
    func testFavoritePersistsAcrossStoreReopening() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("favorites.store")
        let place = makeRequest().destination
        func open() throws -> SwiftDataJourneyStore {
            SwiftDataJourneyStore(container: try ModelContainer(
                for: StoredPlace.self, StoredJourney.self, StoredSettings.self, StoredActiveJourney.self,
                configurations: ModelConfiguration(url: url)
            ))
        }
        do {
            let store = try open()
            try store.setFavorite(place, isFavorite: true)
        }
        let reopened = try open()
        let stored = try XCTUnwrap(reopened.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).first)
        XCTAssertTrue(stored.isFavorite)
        XCTAssertNil(stored.lastUsedAt)
        XCTAssertEqual(stored.place, place)
    }

    @MainActor
    func testPrefillKeepsSuggestionsAndDoesNotSearchUntilEditOrSubmit() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let started = expectation(description: "Initial completions")
        service.onSearch = { _ in started.fulfill() }
        search.edit("Dag")
        let initial = Task { await search.search() }
        await fulfillment(of: [started], timeout: 2)
        let street = Place(name: "Marienplatz", coordinate: Place.munichCenter.coordinate)
        service.resolve("Dag", with: .success([street, Place.munichCenter]))
        await initial.value
        let suggestions = search.results
        search.prefill(street.name)
        await search.search()
        XCTAssertEqual(search.query, "Marienplatz ")
        XCTAssertEqual(search.results, suggestions)
        XCTAssertEqual(service.requestCount, 1)
        XCTAssertEqual(service.resolutionCount, 0)
        XCTAssertFalse(search.isSearching)

        let edited = expectation(description: "House number completions")
        service.onSearch = { query in
            XCTAssertEqual(query, "Marienplatz 5")
            edited.fulfill()
        }
        search.edit(search.query + "5")
        let next = Task { await search.search() }
        await fulfillment(of: [edited], timeout: 2)
        service.resolve("Marienplatz 5", with: .success([street]))
        await next.value
        XCTAssertEqual(service.requestCount, 2)

        search.prefill(street.name)
        let submitted = expectation(description: "Explicit submit")
        service.onSearch = { _ in submitted.fulfill() }
        search.submit()
        let submittedTask = Task { await search.search() }
        await fulfillment(of: [submitted], timeout: 2)
        service.resolve(street.name, with: .success([street]))
        await submittedTask.value
        XCTAssertEqual(service.requestCount, 3)
    }

    @MainActor
    func testPrefillRejectsLateSearchAndResolutionWithoutSelecting() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let started = expectation(description: "Pending completions")
        service.onSearch = { _ in started.fulfill() }
        search.edit("Dag")
        let pending = Task { await search.search() }
        await fulfillment(of: [started], timeout: 2)
        search.prefill("Marienplatz")
        service.resolve("Dag", with: .success([Place.munichCenter]))
        await pending.value
        XCTAssertTrue(search.results.isEmpty)

        let resolving = expectation(description: "Pending place")
        service.onResolve = { resolving.fulfill() }
        let task = Task {
            await search.resolve(PlaceSuggestion(title: "Altstadt"), action: .select) { _, _ in
                XCTFail("Late resolution must not select")
            }
        }
        await fulfillment(of: [resolving], timeout: 2)
        search.edit("Marienplatz 5")
        service.finishResolution(.success([Place.munichCenter]))
        await task.value
        XCTAssertFalse(search.isResolving)
        XCTAssertNil(search.resolutionError)
    }

    @MainActor
    func testResolutionRequiresChoiceAndKeepsFavoriteIntentAndCache() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let suggestion = PlaceSuggestion(title: "Bahnhof")
        let started = expectation(description: "Resolve suggestion")
        service.onResolve = { started.fulfill() }
        let pending = Task {
            await search.resolve(suggestion, action: .favorite) { _, _ in XCTFail("Ambiguous place") }
        }
        await fulfillment(of: [started], timeout: 2)
        // A second tap must not launch another lookup.
        await search.resolve(suggestion, action: .select) { _, _ in XCTFail("Duplicate tap") }
        let request = makeRequest()
        service.finishResolution(.success([request.origin, request.destination, request.origin]))
        await pending.value
        XCTAssertEqual(search.choices.count, 2)
        var selected: Place?
        search.choose(request.destination) { place, action in
            XCTAssertEqual(action, .favorite)
            selected = place
        }
        XCTAssertEqual(selected, request.destination)
        XCTAssertEqual(search.cachedPlace(for: suggestion), request.destination)
        await search.resolve(suggestion, action: .select) { place, action in
            XCTAssertEqual(place, request.destination)
            XCTAssertEqual(action, .select)
        }
        XCTAssertEqual(service.resolutionCount, 1)
    }

    @MainActor
    func testResolutionFailureCanRetryAndCloseRejectsLateSuccess() async {
        let service = ControlledPlaceSearch()
        let search = PlaceSearchModel(service: service)
        let suggestion = PlaceSuggestion(title: "Bahnhof")
        let started = expectation(description: "First lookup")
        service.onResolve = { started.fulfill() }
        let pending = Task {
            await search.resolve(suggestion, action: .favorite) { _, _ in XCTFail("Failed lookup") }
        }
        await fulfillment(of: [started], timeout: 2)
        service.finishResolution(.failure(RoutePlannerError.offline))
        await pending.value
        XCTAssertNotNil(search.resolutionError)
        XCTAssertEqual(search.failedResolution?.0, suggestion)
        let retryStarted = expectation(description: "Retry")
        service.onResolve = { retryStarted.fulfill() }
        let retry = Task {
            await search.resolve(suggestion, action: .favorite) { _, _ in XCTFail("Closed lookup") }
        }
        await fulfillment(of: [retryStarted], timeout: 2)
        search.cancel()
        service.finishResolution(.success([Place.munichCenter]))
        await retry.value
        XCTAssertNil(search.resolutionError)
        XCTAssertTrue(search.choices.isEmpty)
    }

    @MainActor
    func testSearchCenterUsesOnlyFreshAccurateExistingLocation() {
        XCTAssertEqual(PlaceSearchModel.searchCenter(location: nil), Place.munichCenter.coordinate)
        XCTAssertEqual(PlaceSearchModel.searchCenter(location: usablePlanningLocation(age: 120)), Place.munichCenter.coordinate)
        XCTAssertEqual(PlaceSearchModel.searchCenter(location: usablePlanningLocation(accuracy: 200)), Place.munichCenter.coordinate)
        XCTAssertEqual(PlaceSearchModel.searchCenter(location: usablePlanningLocation()),
                       Coordinate(usablePlanningLocation().coordinate))
    }

    @MainActor
    private func makeHomeStore() throws -> SwiftDataJourneyStore {
        let container = try ModelContainer(
            for: StoredPlace.self, StoredJourney.self, StoredSettings.self, StoredActiveJourney.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        return SwiftDataJourneyStore(container: container)
    }

    private func usablePlanningLocation(age: TimeInterval = 0, accuracy: CLLocationAccuracy = 10) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 48.1372, longitude: 11.5756),
            altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: 10,
            timestamp: Date().addingTimeInterval(-age)
        )
    }

    @MainActor
    func testColdLaunchDiscardsPreviewButPreservesUserDataAndLegacyStorage() throws {
        for legacy in [false, true] {
            let store = try makeHomeStore()
            let journey = makeJourney()
            var settings = NavigationSettings.defaults
            settings.audioEnabled = false
            settings.foldingDuration = 240
            try store.saveSettings(settings)
            try store.saveRecentPlace(journey.destination, asDestination: true)
            try store.record(journey)
            try store.saveActiveJourney(journey)
            if legacy {
                let stored = try XCTUnwrap(store.container.mainContext.fetch(FetchDescriptor<StoredActiveJourney>()).first)
                stored.data = try JSONEncoder().encode(journey)
                try store.container.mainContext.save()
            }
            let model = try AppModel(
                planner: UnusedJourneyPlanner(), store: store,
                location: LocationService(), guidance: GuidanceService()
            )
            XCTAssertNil(model.destination)
            XCTAssertNil(model.journey)
            XCTAssertNil(model.navigation)
            XCTAssertTrue(model.journeyOptions.isEmpty)
            XCTAssertEqual(model.planningState, .idle)
            XCTAssertNil(try store.loadActiveSnapshot())
            XCTAssertEqual(model.settings, settings)
            XCTAssertEqual(try store.container.mainContext.fetch(FetchDescriptor<StoredPlace>()).count, 1)
            XCTAssertEqual(try store.container.mainContext.fetch(FetchDescriptor<StoredJourney>()).count, 1)
        }
    }

    @MainActor
    func testStartedNavigationRestoresProgressAndStopsRestoringAfterStop() async throws {
        let store = try makeHomeStore()
        var settings = NavigationSettings.defaults
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        try store.saveSettings(settings)
        let journey = makeResumeJourney()
        let location = LocationService()
        let model = try AppModel(
            planner: UnusedJourneyPlanner(), store: store, location: location, guidance: GuidanceService()
        )
        location.locationManager(CLLocationManager(), didUpdateLocations: [CLLocation(
            coordinate: journey.origin.coordinate.clCoordinate, altitude: 0,
            horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: Date()
        )])
        model.journey = journey
        model.journeyOptions = [journey]
        try store.saveActiveJourney(journey)
        XCTAssertNil(try store.loadActiveSnapshot()?.progress)
        await model.startNavigation()
        let engine = try XCTUnwrap(model.navigation)
        XCTAssertEqual(try store.loadActiveSnapshot()?.progress, NavigationProgress(legIndex: 0, maneuverIndex: 0))
        engine.advance()
        engine.update(location: CLLocation(
            latitude: journey.origin.coordinate.latitude,
            longitude: journey.origin.coordinate.longitude
        ))
        let progress = NavigationProgress(legIndex: 1, maneuverIndex: 1)
        XCTAssertEqual(try store.loadActiveSnapshot()?.progress, progress)
        let restored = try AppModel(
            planner: UnusedJourneyPlanner(), store: store,
            location: LocationService(), guidance: GuidanceService()
        )
        XCTAssertEqual(restored.navigation?.phase, .active(legIndex: 1, maneuverIndex: 1))
        XCTAssertEqual(restored.journey, journey)
        XCTAssertEqual(restored.destination, journey.destination)
        restored.stopNavigation()
        XCTAssertNil(try store.loadActiveSnapshot())
        XCTAssertEqual(restored.journey, journey)
        let stopped = try AppModel(
            planner: UnusedJourneyPlanner(), store: store,
            location: LocationService(), guidance: GuidanceService()
        )
        XCTAssertNil(stopped.navigation)
        XCTAssertNil(stopped.destination)
        model.stopNavigation()
    }

    @MainActor
    func testArrivalClearsRestorableNavigationAndRecordsOnlyOnce() throws {
        let store = try makeHomeStore()
        var settings = NavigationSettings.defaults
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        try store.saveSettings(settings)
        let journey = makeResumeJourney()
        try store.saveActiveSnapshot(ActiveJourneySnapshot(
            journey: journey, progress: NavigationProgress(legIndex: 1, maneuverIndex: 1)
        ))
        let model = try AppModel(
            planner: UnusedJourneyPlanner(), store: store,
            location: LocationService(), guidance: GuidanceService()
        )
        model.navigation?.advance()
        model.navigation?.advance()
        XCTAssertEqual(model.navigation?.phase, .arrived)
        XCTAssertNil(try store.loadActiveSnapshot())
        XCTAssertEqual(try store.container.mainContext.fetch(FetchDescriptor<StoredJourney>()).count, 1)
        let restarted = try AppModel(
            planner: UnusedJourneyPlanner(), store: store,
            location: LocationService(), guidance: GuidanceService()
        )
        XCTAssertNil(restarted.navigation)
        XCTAssertNil(restarted.journey)
        model.stopNavigation()
    }

    @MainActor
    func testFailedAndCancelledNavigationPreparationDoesNotRestore() async throws {
        for cancel in [false, true] {
            let store = try makeHomeStore()
            let started = expectation(description: "Approach requested")
            if !cancel { started.isInverted = true }
            let suspended = SuspendedApproachPlanner(started: started)
            let planner: any JourneyPlanning = cancel ? suspended : UnusedJourneyPlanner()
            let location = LocationService()
            let model = try AppModel(
                planner: planner, store: store, location: location, guidance: GuidanceService()
            )
            let journey = makeJourney()
            model.journey = journey
            try store.saveActiveJourney(journey)
            location.locationManager(CLLocationManager(), didUpdateLocations: [CLLocation(
                coordinate: CLLocationCoordinate2D(
                    latitude: journey.origin.coordinate.latitude + 0.01,
                    longitude: journey.origin.coordinate.longitude
                ), altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: Date()
            )])
            let task = Task { await model.startNavigation() }
            if cancel {
                await fulfillment(of: [started], timeout: 3)
                model.cancelNavigationPreparation()
                await suspended.release()
            }
            await task.value
            XCTAssertNil(model.navigation)
            XCTAssertNil(try store.loadActiveSnapshot()?.progress)
            if cancel {
                XCTAssertEqual(model.navigationStartState, .idle)
                XCTAssertEqual(model.journey, journey)
            } else {
                XCTAssertEqual(model.navigationStartState, .failed(RoutePlannerError.noRoute.localizedDescription))
                await fulfillment(of: [started], timeout: 0.01)
            }
            let restarted = try AppModel(
                planner: UnusedJourneyPlanner(), store: store,
                location: LocationService(), guidance: GuidanceService()
            )
            XCTAssertNil(restarted.navigation)
            XCTAssertNil(restarted.destination)
        }
    }

    @MainActor
    func testInvalidSavedProgressIsDiscarded() throws {
        for progress in [NavigationProgress(legIndex: 7, maneuverIndex: 0),
                         NavigationProgress(legIndex: 0, maneuverIndex: -1),
                         NavigationProgress(legIndex: 0, maneuverIndex: 7)] {
            let store = try makeHomeStore()
            try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: makeResumeJourney(), progress: progress))
            let model = try AppModel(
                planner: UnusedJourneyPlanner(), store: store,
                location: LocationService(), guidance: GuidanceService()
            )
            XCTAssertNil(model.navigation)
            XCTAssertNil(model.journey)
            XCTAssertNil(try store.loadActiveSnapshot())
        }
    }

    @MainActor
    private func makeReturnPlanningModel(
        planner: any JourneyPlanning,
        locationProvider: @escaping @MainActor () async -> CLLocation?
    ) throws -> (AppModel, SwiftDataJourneyStore) {
        let store = try makeHomeStore()
        var settings = NavigationSettings.defaults
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        try store.saveSettings(settings)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: makeResumeJourney(), progress: NavigationProgress(legIndex: 1, maneuverIndex: 1)))
        let model = try AppModel(planner: planner, store: store, location: LocationService(), guidance: GuidanceService(), planningLocationProvider: locationProvider)
        return (model, store)
    }

    @MainActor
    func testStoppingRestoredNavigationRecalculatesThreeOptionsFromCurrentLocationNow() async throws {
        let current = usablePlanningLocation()
        let planner = ReturnAlternativesPlanner(count: 5)
        let (model, store) = try makeReturnPlanningModel(planner: planner, locationProvider: { current })
        let destination = try XCTUnwrap(model.navigation?.journey.destination)
        model.timingSelection = .arrive
        let task = try XCTUnwrap(model.stopNavigationAndReplan())
        XCTAssertNil(model.navigation)
        XCTAssertNil(try store.loadActiveSnapshot())
        XCTAssertTrue(model.isReplanningAfterNavigation)
        XCTAssertEqual(model.planningState, .locating)
        XCTAssertNil(model.stopNavigationAndReplan())
        await model.startNavigation()
        XCTAssertNil(model.navigation)
        await task.value
        let requests = await planner.recordedRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.origin.coordinate, Coordinate(current.coordinate))
        XCTAssertEqual(requests.first?.destination, destination)
        assertFrozenNow(try XCTUnwrap(requests.first).timing)
        XCTAssertEqual(model.journeyOptions.count, 3)
        XCTAssertEqual(model.journey, model.journeyOptions.first)
        XCTAssertEqual(model.planningState, .ready)
        XCTAssertFalse(model.isReplanningAfterNavigation)
        XCTAssertNil(try store.loadActiveSnapshot()?.progress)
        let restarted = try AppModel(planner: planner, store: store, location: LocationService(), guidance: GuidanceService())
        XCTAssertNil(restarted.journey)
        XCTAssertNil(restarted.navigation)
    }

    @MainActor
    func testReturnPlanningDisplaysFewerAvailableOptions() async throws {
        for count in [1, 2] {
            let current = usablePlanningLocation()
            let (model, _) = try makeReturnPlanningModel(planner: ReturnAlternativesPlanner(count: count), locationProvider: { current })
            await model.stopNavigationAndReplan()?.value
            XCTAssertEqual(model.journeyOptions.count, count)
            XCTAssertEqual(model.planningState, .ready)
        }
    }

    @MainActor
    func testReturnPlanningMissingLocationCanRetryWithoutRestartingNavigation() async throws {
        var current: CLLocation?
        let planner = ReturnAlternativesPlanner(count: 3)
        let (model, store) = try makeReturnPlanningModel(planner: planner, locationProvider: { current })
        await model.stopNavigationAndReplan()?.value
        guard case .failed = model.planningState else { return XCTFail("Expected location failure") }
        XCTAssertNil(model.origin)
        XCTAssertNil(model.navigation)
        XCTAssertTrue(model.isReplanningAfterNavigation)
        XCTAssertNil(try store.loadActiveSnapshot())
        let requests = await planner.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
        current = usablePlanningLocation()
        await model.retryPlanningAfterNavigation()?.value
        XCTAssertEqual(model.journeyOptions.count, 3)
        XCTAssertEqual(model.planningState, .ready)
    }

    @MainActor
    func testReturnPlanningNetworkFailureCanRetry() async throws {
        let current = usablePlanningLocation()
        let planner = ReturnAlternativesPlanner(count: 3, failFirst: true)
        let (model, store) = try makeReturnPlanningModel(planner: planner, locationProvider: { current })
        await model.stopNavigationAndReplan()?.value
        guard case .failed = model.planningState else { return XCTFail("Expected planner failure") }
        XCTAssertTrue(model.isReplanningAfterNavigation)
        XCTAssertNil(model.navigation)
        XCTAssertNil(try store.loadActiveSnapshot())
        await model.startNavigation()
        XCTAssertNil(model.navigation)
        await model.retryPlanningAfterNavigation()?.value
        XCTAssertEqual(model.planningState, .ready)
        XCTAssertEqual(model.journeyOptions.count, 3)
    }

    @MainActor
    func testLateReturnPlanningCannotReplaceNewDestinationOrRestoreDiscardedRoute() async throws {
        for replaceDestination in [false, true] {
            let current = usablePlanningLocation()
            let started = expectation(description: "Return calculation started")
            let planner = ReturnAlternativesPlanner(count: 3, started: started)
            let (model, store) = try makeReturnPlanningModel(planner: planner, locationProvider: { current })
            let task = try XCTUnwrap(model.stopNavigationAndReplan())
            await fulfillment(of: [started], timeout: 2)
            if replaceDestination {
                await model.planToDestination(Place(name: "Neues Ziel", coordinate: Coordinate(latitude: 49, longitude: 12)))
            } else {
                model.discardRoute()
            }
            let expected = model.journey
            await planner.release()
            await task.value
            XCTAssertEqual(model.journey, expected)
            XCTAssertEqual(try store.loadActiveJourney(), expected)
            XCTAssertNil(model.navigation)
            XCTAssertFalse(model.isReplanningAfterNavigation)
        }
    }

    @MainActor
    func testLateLocationAfterClearingDataDoesNotBeginReturnPlanning() async throws {
        let gate = PlanningLocationGate()
        let requested = expectation(description: "Location requested")
        gate.onRequest = { requested.fulfill() }
        let planner = ReturnAlternativesPlanner(count: 3)
        let (model, store) = try makeReturnPlanningModel(planner: planner, locationProvider: { await gate.location() })
        let task = try XCTUnwrap(model.stopNavigationAndReplan())
        await fulfillment(of: [requested], timeout: 2)
        model.clearLocalData()
        gate.resolve(usablePlanningLocation())
        await task.value
        let requests = await planner.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertNil(model.journey)
        XCTAssertNil(try store.loadActiveSnapshot())
        XCTAssertEqual(model.planningState, .idle)
    }

    private func makeResumeJourney() -> Journey {
        let base = makeJourney()
        let movement = MovementLeg(
            from: base.origin, to: base.destination,
            startTime: base.departure, endTime: base.arrival,
            distance: 4_200, coordinates: [base.origin.coordinate, base.destination.coordinate],
            maneuvers: [
                Maneuver(direction: .depart, instruction: "Losfahren", streetName: "", distance: 100,
                         coordinates: [base.origin.coordinate]),
                Maneuver(direction: .straight, instruction: "Weiterfahren", streetName: "", distance: 100,
                         coordinates: [base.origin.coordinate, base.destination.coordinate])
            ]
        )
        return Journey(
            id: "resume", origin: base.origin, destination: base.destination,
            departure: base.departure, arrival: base.arrival,
            legs: [.bike(movement), .bike(movement)], transfers: 0, isDirect: true,
            score: base.score
        )
    }

    @MainActor
    func testNavigationEngineAdvancesMovementAndTimedTransition() {
        let request = makeRequest()
        let start = date("2026-09-04T08:00:00Z")
        let interchange = Place(
            name: "Marienplatz",
            coordinate: Coordinate(latitude: 48.1370, longitude: 11.5754)
        )
        let movement = MovementLeg(
            from: request.origin,
            to: interchange,
            startTime: start,
            endTime: start.addingTimeInterval(420),
            distance: 1_250,
            coordinates: [request.origin.coordinate, interchange.coordinate],
            maneuvers: []
        )
        let fold = TransitionLeg(
            place: interchange,
            startTime: movement.endTime,
            endTime: movement.endTime.addingTimeInterval(180)
        )
        let journey = Journey(
            id: "navigation-journey",
            origin: request.origin,
            destination: interchange,
            departure: movement.startTime,
            arrival: fold.endTime,
            legs: [.bike(movement), .fold(fold)],
            transfers: 0,
            isDirect: false,
            score: fold.endTime.timeIntervalSince1970
        )
        var settings = NavigationSettings.defaults
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        let engine = NavigationEngine(journey: journey, settings: settings, guidance: GuidanceService())
        var arrived = false
        engine.onArrival = { arrived = true }

        engine.start()
        XCTAssertEqual(engine.phase, .active(legIndex: 0, maneuverIndex: 0))

        engine.update(
            location: CLLocation(
                coordinate: interchange.coordinate.clCoordinate,
                altitude: 0,
                horizontalAccuracy: 5,
                verticalAccuracy: 5,
                timestamp: start
            )
        )
        XCTAssertEqual(engine.phase, .active(legIndex: 1, maneuverIndex: 0))

        engine.tick(now: fold.endTime)
        XCTAssertEqual(engine.phase, .arrived)
        XCTAssertTrue(arrived)
    }

    @MainActor
    func testNavigationEngineRequestsRerouteAfterThreeReliableOffRouteSamples() {
        let journey = makeJourney()
        var settings = NavigationSettings.defaults
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        let engine = NavigationEngine(journey: journey, settings: settings, guidance: GuidanceService())
        var rerouteCount = 0
        engine.onReroute = { rerouteCount += 1 }
        let offRoute = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 48.25, longitude: 11.75),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            timestamp: date("2026-09-04T08:05:00Z")
        )

        engine.start()
        engine.update(location: offRoute)
        engine.update(location: offRoute)
        XCTAssertEqual(rerouteCount, 0)

        engine.update(location: offRoute)
        XCTAssertEqual(rerouteCount, 1)
        XCTAssertTrue(engine.isReplanning)
    }

    private func makeClient(
        recorder: RequestRecorder? = nil,
        response: @escaping (URLRequest) throws -> Data
    ) -> TransitousClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.handler = { request in
            recorder?.append(request)
            let data = try response(request)
            let httpResponse = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (httpResponse, data)
        }
        return TransitousClient(
            session: URLSession(configuration: configuration),
            userAgent: "FoldRouteTests/1.0 (tests@example.invalid)",
            planningPause: PlanningServerPause()
        )
    }

    private func makeRequest() -> RouteRequest {
        RouteRequest(
            origin: Place(
                name: "Gärtnerplatz",
                coordinate: Coordinate(latitude: 48.1320, longitude: 11.5760)
            ),
            destination: Place(
                name: "Englischer Garten",
                coordinate: Coordinate(latitude: 48.1750, longitude: 11.6000)
            ),
            timing: .departAt(date("2026-09-04T08:00:00Z"))
        )
    }

    private func makeJourney(
        id: String = "saved-journey",
        origin: Place? = nil,
        destination: Place? = nil
    ) -> Journey {
        let request = makeRequest()
        let origin = origin ?? request.origin
        let destination = destination ?? request.destination
        let movement = MovementLeg(
            from: origin,
            to: destination,
            startTime: date("2026-09-04T08:00:00Z"),
            endTime: date("2026-09-04T08:20:00Z"),
            distance: 4_200,
            coordinates: [origin.coordinate, destination.coordinate],
            maneuvers: []
        )
        return Journey(
            id: id,
            origin: origin,
            destination: destination,
            departure: movement.startTime,
            arrival: movement.endTime,
            legs: [.bike(movement)],
            transfers: 0,
            isDirect: true,
            score: movement.endTime.timeIntervalSince1970
        )
    }

    private func makeOptionJourney(
        id: String,
        departure: String,
        arrival: String,
        line: String? = nil,
        transfers: Int = 0
    ) -> Journey {
        let request = makeRequest()
        let departure = date(departure)
        let arrival = date(arrival)
        let legs: [JourneyLeg]
        if let line {
            let station = Place(
                name: "Umstieg",
                coordinate: Coordinate(latitude: 48.145, longitude: 11.585)
            )
            legs = [
                .transit(
                    TransitLeg(
                        from: station,
                        to: request.destination,
                        startTime: departure,
                        endTime: arrival,
                        mode: "SUBURBAN",
                        line: line,
                        headsign: request.destination.name,
                        agency: "Test",
                        departurePlatform: nil,
                        arrivalPlatform: nil,
                        isRealtime: false,
                        isCancelled: false,
                        coordinates: [station.coordinate, request.destination.coordinate]
                    )
                )
            ]
        } else {
            legs = [
                .bike(
                    MovementLeg(
                        from: request.origin,
                        to: request.destination,
                        startTime: departure,
                        endTime: arrival,
                        distance: 10_000,
                        coordinates: [request.origin.coordinate, request.destination.coordinate],
                        maneuvers: []
                    )
                )
            ]
        }
        return Journey(
            id: id,
            origin: request.origin,
            destination: request.destination,
            departure: departure,
            arrival: arrival,
            legs: legs,
            transfers: transfers,
            isDirect: line == nil,
            score: arrival.timeIntervalSince1970
        )
    }

    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }
}

private func queryValue(_ name: String, in request: URLRequest) -> String? {
    guard let url = request.url,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    return components.queryItems?.first { $0.name == name }?.value
}

private struct UnusedJourneyPlanner: JourneyPlanning {
    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        throw RoutePlannerError.noRoute
    }

    func planDirectBike(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> Journey {
        throw RoutePlannerError.noRoute
    }
}

private struct StaticAlternativeJourneyPlanner: JourneyPlanning {
    let journeys: [Journey]

    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        guard let journey = journeys.first else { throw RoutePlannerError.noRoute }
        return journey
    }

    func planAlternatives(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> [Journey] {
        journeys
    }

    func planDirectBike(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> Journey {
        guard let journey = journeys.first(where: \.isDirect) ?? journeys.first else {
            throw RoutePlannerError.noRoute
        }
        return journey
    }
}

private actor SuspendedApproachPlanner: JourneyPlanning {
    let started: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Never>?

    init(started: XCTestExpectation) {
        self.started = started
    }

    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        try await RecordingJourneyPlanner().plan(request, settings: settings)
    }

    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        let journey = try await plan(request, settings: settings)
        await withCheckedContinuation {
            continuation = $0
            started.fulfill()
        }
        return journey
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private actor ReturnAlternativesPlanner: JourneyPlanning {
    let count: Int
    let failFirst: Bool
    let started: XCTestExpectation?
    private var requests: [RouteRequest] = []
    private var continuation: CheckedContinuation<Void, Never>?

    init(count: Int, failFirst: Bool = false, started: XCTestExpectation? = nil) {
        self.count = count
        self.failFirst = failFirst
        self.started = started
    }

    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        try await RecordingJourneyPlanner().plan(request, settings: settings)
    }

    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        try await plan(request, settings: settings)
    }

    func planAlternatives(_ request: RouteRequest, settings: NavigationSettings) async throws -> [Journey] {
        requests.append(request)
        let first = requests.count == 1
        if first, failFirst { throw URLError(.notConnectedToInternet) }
        if first, let started {
            await withCheckedContinuation { continuation = $0; started.fulfill() }
        }
        let generator = RecordingJourneyPlanner()
        var options: [Journey] = []
        for _ in 0..<count { options.append(try await generator.plan(request, settings: settings)) }
        return options
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }

    func recordedRequests() -> [RouteRequest] { requests }
}

private actor RecordingJourneyPlanner: JourneyPlanning {
    private var requests: [RouteRequest] = []
    private var usedSettings: [NavigationSettings] = []
    func recordedSettings() -> [NavigationSettings] { usedSettings }

    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        requests.append(request)
        usedSettings.append(settings)
        let departure = Date()
        let arrival = departure.addingTimeInterval(1_200)
        let movement = MovementLeg(
            from: request.origin,
            to: request.destination,
            startTime: departure,
            endTime: arrival,
            distance: request.origin.coordinate.distance(to: request.destination.coordinate),
            coordinates: [request.origin.coordinate, request.destination.coordinate],
            maneuvers: []
        )
        return Journey(
            id: "recorded-\(requests.count)",
            origin: request.origin,
            destination: request.destination,
            departure: departure,
            arrival: arrival,
            legs: [.bike(movement)],
            transfers: 0,
            isDirect: true,
            score: arrival.timeIntervalSince1970
        )
    }

    func planDirectBike(
        _ request: RouteRequest,
        settings: NavigationSettings
    ) async throws -> Journey {
        try await plan(request, settings: settings)
    }

    func recordedRequests() -> [RouteRequest] {
        requests
    }
}

@MainActor
private struct StaticHistoryPlaceNameResolver: HistoryPlaceNameResolving {
    let name: String?

    func displayName(for coordinate: Coordinate) async throws -> String? {
        name
    }
}

@MainActor
private final class PlanningLocationGate {
    var onRequest: (() -> Void)?
    private var continuation: CheckedContinuation<CLLocation?, Never>?

    func location() async -> CLLocation? {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            onRequest?()
        }
    }

    func resolve(_ location: CLLocation?) {
        precondition(continuation != nil)
        continuation?.resume(returning: location)
        continuation = nil
    }
}

@MainActor
private final class ControlledPlaceSearch: PlaceSearching {
    var onSearch: ((String) -> Void)?
    var onResolve: (() -> Void)?
    private(set) var requestCount = 0
    private(set) var resolutionCount = 0
    private(set) var cancelCount = 0
    private(set) var lastCenter: Coordinate?
    private var continuations: [String: CheckedContinuation<[PlaceSuggestion], Error>] = [:]
    private var resolution: CheckedContinuation<[Place], Error>?

    func search(_ query: String, near center: Coordinate) async throws -> [PlaceSuggestion] {
        requestCount += 1
        lastCenter = center
        return try await withCheckedThrowingContinuation { continuation in
            continuations[query] = continuation
            onSearch?(query)
        }
    }

    func resolve(_ suggestion: PlaceSuggestion) async throws -> [Place] {
        resolutionCount += 1
        return try await withCheckedThrowingContinuation { continuation in
            resolution = continuation
            onResolve?()
        }
    }

    func finishResolution(_ result: Result<[Place], Error>) {
        let pending = resolution
        resolution = nil
        pending?.resume(with: result)
    }

    func cancel() { cancelCount += 1 }

    func resolve(_ query: String, with result: Result<[Place], Error>) {
        guard let continuation = continuations.removeValue(forKey: query) else {
            preconditionFailure("No pending search for \(query)")
        }
        continuation.resume(with: result.map { places in
            places.map { PlaceSuggestion(id: $0.id, title: $0.name, subtitle: $0.detail) }
        })
    }
}

extension FoldRouteTests {
    private func accessFixture(pre: String, post: String, seconds: Double = 120, internalWalk: Bool = false) throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: TransitousFixtures.multimodal) as? [String: Any])
        var itinerary = try XCTUnwrap((root["itineraries"] as? [[String: Any]])?.first)
        var legs = try XCTUnwrap(itinerary["legs"] as? [[String: Any]])
        let formatter = ISO8601DateFormatter()
        legs[0]["mode"] = pre
        legs[0]["startTime"] = formatter.string(from: date("2026-09-04T08:10:00Z").addingTimeInterval(-seconds))
        legs[0]["distance"] = pre == "WALK" ? 100 : 1100
        legs[2]["mode"] = post
        legs[2]["startTime"] = formatter.string(from: date("2026-09-04T08:50:00Z").addingTimeInterval(-seconds))
        legs[2]["distance"] = post == "WALK" ? 100 : 1100
        if internalWalk {
            var walk = legs[2]
            walk["mode"] = "WALK"
            walk["startTime"] = "2026-09-04T08:35:00Z"
            walk["endTime"] = "2026-09-04T08:45:00Z"
            var transit = legs[1]
            transit["startTime"] = "2026-09-04T08:45:00Z"
            transit["endTime"] = "2026-09-04T08:47:00Z"
            legs.insert(contentsOf: [walk, transit], at: 2)
        }
        itinerary["legs"] = legs
        root["itineraries"] = [itinerary]
        return try JSONSerialization.data(withJSONObject: root)
    }

    func testWalkingVariantsUseSeparateLimitsAndSamePlanningTime() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { [self] request in
            guard let pre = queryValue("preTransitModes", in: request),
                  let post = queryValue("postTransitModes", in: request) else { return TransitousFixtures.empty }
            return try accessFixture(pre: pre, post: post)
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        settings.maxWalkingMinutes = 7
        settings.maxCyclingMinutes = 60
        let options = try await client.planAlternatives(makeRequest(), settings: settings)
        let requests = recorder.requests.filter { queryValue("preTransitModes", in: $0) != nil }
        XCTAssertEqual(Set(requests.map { "\(queryValue("preTransitModes", in: $0)!)|\(queryValue("postTransitModes", in: $0)!)" }),
                       ["WALK|WALK", "WALK|BIKE", "BIKE|WALK", "BIKE|BIKE"])
        XCTAssertEqual(Set(requests.compactMap { queryValue("time", in: $0) }), ["2026-09-04T08:03:00Z"])
        for request in requests {
            XCTAssertEqual(queryValue("maxPreTransitTime", in: request), queryValue("preTransitModes", in: request) == "WALK" ? "420" : "3600")
            XCTAssertEqual(queryValue("maxPostTransitTime", in: request), queryValue("postTransitModes", in: request) == "WALK" ? "420" : "3600")
        }
        XCTAssertEqual(options.count, 1, "Same concrete train must not fill multiple cards")
        XCTAssertEqual(options.first?.legs.map(\.kind), [.walk, .fold, .transit, .unfold, .walk])
        XCTAssertEqual(options.first?.arrival, date("2026-09-04T08:53:00Z"))
    }

    func testWalkingLimitBoundaryAndMixedAccessModes() async throws {
        for (pre, post) in [("WALK", "WALK"), ("WALK", "BIKE"), ("BIKE", "WALK")] {
            for seconds in [119.0, 120.0, 121.0] {
                let client = makeClient { [self] request in
                    guard queryValue("preTransitModes", in: request) == pre,
                          queryValue("postTransitModes", in: request) == post else { return TransitousFixtures.empty }
                    return try accessFixture(pre: pre, post: post, seconds: seconds)
                }
                var settings = NavigationSettings.defaults
                settings.maxBikeTransfers = 0
                do {
                    let options = try await client.planAlternatives(makeRequest(), settings: settings)
                    XCTAssertLessThanOrEqual(seconds, 120)
                    XCTAssertEqual(options.first?.legs.first?.kind, pre == "WALK" ? .walk : .bike)
                    XCTAssertEqual(options.first?.legs.last?.kind, post == "WALK" ? .walk : .bike)
                } catch {
                    XCTAssertEqual(seconds, 121)
                    XCTAssertEqual(error as? RoutePlannerError, .noRoute)
                }
            }
        }
    }

    func testLongInternalWalkDoesNotCountAgainstZubringerLimit() async throws {
        let client = makeClient { [self] request in
            guard queryValue("preTransitModes", in: request) == "WALK",
                  queryValue("postTransitModes", in: request) == "WALK" else { return TransitousFixtures.empty }
            return try accessFixture(pre: "WALK", post: "WALK", internalWalk: true)
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let route = try await client.plan(makeRequest(), settings: settings)
        XCTAssertEqual(route.legs.filter { $0.kind == .walk }.count, 3)
    }

    func testWalkingArriveByReservesUnfoldTimeForAllVariants() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { [self] request in
            guard let pre = queryValue("preTransitModes", in: request),
                  let post = queryValue("postTransitModes", in: request) else { return TransitousFixtures.empty }
            return try accessFixture(pre: pre, post: post)
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let original = makeRequest()
        let request = RouteRequest(origin: original.origin, destination: original.destination,
                                   timing: .arriveBy(date("2026-09-04T09:00:00Z")))
        _ = try await client.planAlternatives(request, settings: settings)
        for query in recorder.requests where queryValue("preTransitModes", in: query) != nil {
            XCTAssertEqual(queryValue("time", in: query), "2026-09-04T08:57:00Z")
            XCTAssertEqual(queryValue("arriveBy", in: query), "true")
        }
    }

    @MainActor
    func testWalkingSettingsPersistAndLegacyDefaultsRemainCompatible() throws {
        let store = try makeHomeStore()
        var settings = NavigationSettings.defaults
        XCTAssertEqual(settings.maxWalkingMinutes, 2)
        settings.maxWalkingMinutes = 9
        try store.saveSettings(settings)
        XCTAssertEqual(try store.loadSettings().maxWalkingMinutes, 9)
        XCTAssertEqual(try JSONDecoder().decode(NavigationSettings.self, from: JSONEncoder().encode(settings)), settings)
        XCTAssertEqual(try JSONDecoder().decode(NavigationSettings.self, from: Data("{}".utf8)).maxWalkingMinutes, 2)
        let stored = StoredSettings()
        stored.maxWalkingMinutes = nil
        XCTAssertEqual(stored.value.maxWalkingMinutes, 2)
        stored.maxWalkingMinutes = 99
        XCTAssertEqual(stored.value.maxWalkingMinutes, 15)
    }

    func testShortWalkBeatsChasingSameTrainButFasterBikeStillWins() throws {
        func route(id: String, bike: Bool, arrivalOffset: Double = 0, tripID: String = "S8-day1") -> Journey {
            let origin = Place(name: "Hbf", coordinate: Coordinate(latitude: 48.14, longitude: 11.56))
            let station = Place(name: bike ? "Stachus" : "Hbf", coordinate: Coordinate(latitude: 48.14, longitude: bike ? 11.57 : 11.56))
            let destination = Place(name: "Ostbahnhof", coordinate: Coordinate(latitude: 48.1275, longitude: 11.6047))
            let start = date("2026-09-04T17:50:00Z")
            let board = start.addingTimeInterval(bike ? 300 : 180)
            let end = start.addingTimeInterval(1200 + arrivalOffset)
            let movement = MovementLeg(from: origin, to: station, startTime: start, endTime: board.addingTimeInterval(-60),
                distance: bike ? 1100 : 80, coordinates: [origin.coordinate, station.coordinate], maneuvers: [])
            let transit = TransitLeg(from: station, to: destination, startTime: board, endTime: end,
                mode: "SUBURBAN", line: "S8", headsign: "Flughafen", agency: "Test", departurePlatform: "1", arrivalPlatform: "2",
                isRealtime: false, isCancelled: false, coordinates: [station.coordinate, destination.coordinate],
                reference: TransitReference(tripID: tripID, fromID: station.name, toID: destination.name,
                    scheduledDeparture: board, scheduledArrival: end))
            return Journey(id: id, origin: origin, destination: destination, departure: start, arrival: end,
                legs: [bike ? .bike(movement) : .walk(movement),
                       .fold(TransitionLeg(place: station, startTime: movement.endTime, endTime: board)), .transit(transit)],
                transfers: 0, isDirect: false, score: 0)
        }
        let walk = route(id: "walk", bike: false)
        let bike = route(id: "bike", bike: true)
        XCTAssertEqual(JourneyOptionSelector.select(from: [bike, walk], timing: .leaveNow).map(\.id), ["walk"])
        let faster = route(id: "faster-bike", bike: true, arrivalOffset: -60, tripID: "S8-earlier")
        XCTAssertEqual(JourneyOptionSelector.select(from: [walk, faster], timing: .leaveNow).first?.id, "faster-bike")
        let nextDay = walk.replacingLegs(walk.legs.map { leg in
            guard case .transit(let transit) = leg, let reference = transit.reference else { return leg }
            return .transit(TransitLeg(from: transit.from, to: transit.to,
                startTime: transit.startTime.addingTimeInterval(86_400), endTime: transit.endTime.addingTimeInterval(86_400),
                mode: transit.mode, line: transit.line, headsign: transit.headsign, agency: transit.agency,
                departurePlatform: transit.departurePlatform, arrivalPlatform: transit.arrivalPlatform,
                isRealtime: false, isCancelled: false, coordinates: transit.coordinates,
                reference: TransitReference(tripID: reference.tripID, fromID: reference.fromID, toID: reference.toID,
                    scheduledDeparture: reference.scheduledDeparture.addingTimeInterval(86_400),
                    scheduledArrival: reference.scheduledArrival.addingTimeInterval(86_400))))
        })
        XCTAssertEqual(JourneyOptionSelector.select(from: [walk, nextDay], timing: .leaveNow).count, 2)
    }
}

private final class RoutingGate: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [GatedRoutingProtocol] = []
    private var started = 0
    private var peak = 0
    private var updates: [JourneyOptionsUpdate] = []
    var counts: (started: Int, active: Int, peak: Int) { lock.withLock { (started, pending.count, peak) } }
    var values: [JourneyOptionsUpdate] { lock.withLock { updates } }
    func record(_ update: JourneyOptionsUpdate) { lock.withLock { updates.append(update) } }
    func add(_ request: GatedRoutingProtocol) {
        lock.withLock { pending.append(request); started += 1; peak = max(peak, pending.count) }
    }
    func remove(_ request: GatedRoutingProtocol) {
        lock.withLock { pending.removeAll { $0 === request } }
    }
    @discardableResult
    func finishNext(direct: Bool? = nil, status: Int = 200, data: Data? = nil) -> Bool {
        let request = lock.withLock { () -> GatedRoutingProtocol? in
            guard let index = pending.firstIndex(where: { request in
                guard let direct else { return true }
                let isDirect = URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains {
                    $0.name == "directModes" && $0.value == "BIKE"
                } == true
                return direct == isDirect
            }) else { return nil }
            return pending.remove(at: index)
        }
        guard let request else { return false }
        let response = HTTPURLResponse(url: request.request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        request.client?.urlProtocol(request, didReceive: response, cacheStoragePolicy: .notAllowed)
        let isDirect = URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "directModes" && $0.value == "BIKE" } == true
        request.client?.urlProtocol(request, didLoad: data ?? (isDirect ? TransitousFixtures.directBike : TransitousFixtures.delfiPlatformCodes))
        request.client?.urlProtocolDidFinishLoading(request)
        return true
    }
}

private final class GatedRoutingProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var gate = RoutingGate()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.gate.add(self) }
    override func stopLoading() { Self.gate.remove(self) }
}

extension FoldRouteTests {
    private func gatedClient() -> (TransitousClient, RoutingGate) {
        let gate = RoutingGate()
        GatedRoutingProtocol.gate = gate
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GatedRoutingProtocol.self]
        return (TransitousClient(session: URLSession(configuration: configuration), planningPause: PlanningServerPause()), gate)
    }

    private func awaitGate(_ predicate: @Sendable () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Routing requests did not reach expected state")
    }

    func testAccessSearchStreamsResultsWithAtMostTwoConcurrentRequests() async throws {
        let (client, gate) = gatedClient()
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let request = makeRequest()
        let task = Task {
            for try await update in client.alternativeUpdates(request, settings: settings) { gate.record(update) }
        }
        try await awaitGate { gate.counts.active == 2 }
        XCTAssertTrue(gate.finishNext(direct: true))
        try await awaitGate { gate.counts.started == 3 && !gate.values.isEmpty }
        XCTAssertEqual(gate.values.first?.status, .searching)
        XCTAssertEqual(gate.counts.active, 2)
        for expected in 4...5 {
            XCTAssertTrue(gate.finishNext())
            try await awaitGate { gate.counts.started == expected }
        }
        while gate.finishNext() {}
        try await task.value
        XCTAssertEqual(gate.counts.started, 5)
        XCTAssertLessThanOrEqual(gate.counts.peak, 2)
        XCTAssertEqual(gate.values.last?.status, .complete)
    }

    func testAccessRateLimitRetainsResultsAndStopsQueuedRequests() async throws {
        let (client, gate) = gatedClient()
        let request = makeRequest()
        let task = Task {
            for try await update in client.alternativeUpdates(request, settings: .defaults) { gate.record(update) }
        }
        try await awaitGate { gate.counts.active == 2 }
        XCTAssertTrue(gate.finishNext(direct: true))
        try await awaitGate { gate.counts.started == 3 && !gate.values.isEmpty }
        XCTAssertTrue(gate.finishNext(status: 429))
        try await task.value
        XCTAssertEqual(gate.counts.started, 3)
        XCTAssertEqual(gate.values.last?.status, .partial)
        XCTAssertFalse(gate.values.last?.journeys.isEmpty ?? true)
    }

    func testAccessCancellationStopsActiveAndQueuedRequests() async throws {
        let (client, gate) = gatedClient()
        let request = makeRequest()
        let task = Task {
            for try await update in client.alternativeUpdates(request, settings: .defaults) { gate.record(update) }
        }
        try await awaitGate { gate.counts.active == 2 }
        task.cancel()
        _ = await task.result
        try await awaitGate { gate.counts.active == 0 }
        XCTAssertEqual(gate.counts.started, 2)
        XCTAssertTrue(gate.values.isEmpty)
    }

    func testAccessPartialFailureStillFinishesRemainingVariants() async throws {
        let (client, gate) = gatedClient()
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let request = makeRequest()
        let task = Task {
            for try await update in client.alternativeUpdates(request, settings: settings) { gate.record(update) }
        }
        try await awaitGate { gate.counts.active == 2 }
        XCTAssertTrue(gate.finishNext(direct: true, status: 500))
        try await awaitGate { gate.counts.started == 3 }
        for expected in 4...5 {
            XCTAssertTrue(gate.finishNext())
            try await awaitGate { gate.counts.started == expected }
        }
        while gate.finishNext() {}
        try await task.value
        XCTAssertEqual(gate.counts.started, 5)
        XCTAssertEqual(gate.values.last?.status, .partial)
        XCTAssertFalse(gate.values.last?.journeys.isEmpty ?? true)
    }
}

extension FoldRouteTests {
    private func benefitJourney(id: String, direct: Bool, bikeMeters: Double,
                                departure: Double = 0, arrival: Double = 1800) -> Journey {
        let request = makeRequest()
        let base = date("2026-09-04T08:00:00Z")
        let start = base.addingTimeInterval(departure)
        let end = base.addingTimeInterval(arrival)
        let movement = MovementLeg(from: request.origin, to: request.destination,
            startTime: start, endTime: end, distance: bikeMeters,
            coordinates: [request.origin.coordinate, request.destination.coordinate], maneuvers: [])
        return Journey(id: id, origin: request.origin, destination: request.destination,
            departure: start, arrival: end, legs: [.bike(movement)], transfers: 0, isDirect: direct, score: 0)
    }

    func testDisabledCyclingComparisonKeepsTransitAndRejectsOnlyLongDirectResults() async throws {
        var settings = NavigationSettings.defaults
        settings.showCyclingComparison = false
        settings.maxBikeTransfers = 0
        let client = makeClient { request in
            queryValue("directModes", in: request) == "BIKE" ? TransitousFixtures.directBike : TransitousFixtures.multimodal
        }
        let routes = try await client.planAlternatives(makeRequest(), settings: settings)
        XCTAssertFalse(routes.isEmpty)
        XCTAssertTrue(routes.allSatisfy { !$0.isDirect })
        let directOnly = makeClient { _ in TransitousFixtures.directBike }
        settings.excludedTransitModes = Set(TransitModePreference.allCases)
        do {
            _ = try await directOnly.planAlternatives(makeRequest(), settings: settings)
            XCTFail("Hidden comparisons must not become results")
        } catch { XCTAssertEqual(error as? RoutePlannerError, .noRoute) }
        settings.maxCyclingMinutes = 60
        let short = try await directOnly.planAlternatives(makeRequest(), settings: settings)
        XCTAssertTrue(short.first?.isDirect == true)
    }

    func testOptionalFourthCyclingComparison() throws {
        let long = benefitJourney(id: "long", direct: true, bikeMeters: 10000, arrival: 2760)
        let regular = (0..<4).map { benefitJourney(id: "fit-\($0)", direct: false, bikeMeters: 1000, arrival: 5400 + Double($0) * 300) }
        for timing in [RouteTiming.leaveNow, .arriveBy(Date(timeIntervalSince1970: 10000))] {
            XCTAssertEqual(JourneyOptionSelector.select(from: regular + [long], timing: timing, cyclingLimit: 30).map(\.id), ["fit-0", "fit-1", "fit-2", "long"])
            XCTAssertEqual(JourneyOptionSelector.select(from: regular + [long], timing: timing, cyclingLimit: 30, showCyclingComparison: false).map(\.id), ["fit-0", "fit-1", "fit-2"])
        }
        XCTAssertTrue(JourneyOptionSelector.select(from: [long], timing: .leaveNow, cyclingLimit: 30, showCyclingComparison: false).isEmpty)
        for seconds in [1799.0, 1800] {
            let short = benefitJourney(id: "short", direct: true, bikeMeters: 1000, arrival: seconds)
            XCTAssertEqual(JourneyOptionSelector.select(from: [short, long], timing: .leaveNow, cyclingLimit: 30, showCyclingComparison: false).map(\.id), ["short"])
        }
        XCTAssertEqual(JourneyOptionSelector.retaining(long, in: regular, cyclingLimit: 30, showComparison: true).map(\.id), ["fit-0", "fit-1", "fit-2", "long"])
        let selected = benefitJourney(id: "selected", direct: false, bikeMeters: 1000, arrival: 7000)
        XCTAssertEqual(JourneyOptionSelector.retaining(selected, in: Array(regular.prefix(3)) + [long], cyclingLimit: 30, showComparison: true).map(\.id), ["selected", "fit-0", "fit-1", "long"])
        var settings = NavigationSettings.defaults
        settings.showCyclingComparison = false
        let stored = StoredSettings(settings: settings)
        XCTAssertFalse(stored.value.showCyclingComparison)
        XCTAssertFalse(try JSONDecoder().decode(NavigationSettings.self, from: JSONEncoder().encode(settings)).showCyclingComparison)
        stored.showCyclingComparison = nil
        XCTAssertTrue(stored.value.showCyclingComparison)
        XCTAssertTrue(try JSONDecoder().decode(NavigationSettings.self, from: Data("{}".utf8)).showCyclingComparison)
    }

    func testCyclingComparisonsPreferSuitableRoutesAndRespectBoundary() {
        let long = benefitJourney(id: "long", direct: true, bikeMeters: 10000, arrival: 2760)
        let fit = benefitJourney(id: "fit", direct: false, bikeMeters: 1000, arrival: 5400)
        for seconds in [1740.0, 1800] {
            XCTAssertEqual(CyclingComparison.excess(benefitJourney(id: "boundary", direct: true, bikeMeters: 10000, arrival: seconds), limit: 30), 0)
        }
        XCTAssertEqual(CyclingComparison.label(long, limit: 30), "46 Min. Radfahrt · 16 Min. über deinem Radlimit")
        XCTAssertNil(CyclingComparison.label(long, limit: 60))
        for timing in [RouteTiming.leaveNow, .arriveBy(Date(timeIntervalSince1970: 10000))] {
            XCTAssertEqual(JourneyOptionSelector.select(from: [long, fit], timing: timing, cyclingLimit: 30).map(\.id), ["fit", "long"])
        }
        XCTAssertEqual(JourneyOptionSelector.select(from: [long, fit], timing: .leaveNow, maximumOptions: 1, cyclingLimit: 30).map(\.id), ["fit"])
        XCTAssertEqual(JourneyOptionSelector.select(from: [long], timing: .leaveNow, cyclingLimit: 30).map(\.id), ["long"])
    }

    func testTransitBenefitTimeThresholdUsesTotalArrivalNotDuration() {
        let direct = benefitJourney(id: "direct", direct: true, bikeMeters: 8000)
        for saving in [179.0, 180, 181] {
            let route = benefitJourney(id: "transit", direct: false, bikeMeters: 7900, departure: 600, arrival: 1800 - saving)
            XCTAssertEqual(TransitBenefitPolicy.isWorthwhile(route, comparedTo: direct, timing: .leaveNow), saving >= 180)
        }
        let laterButShorter = benefitJourney(id: "late", direct: false, bikeMeters: 7900, departure: 1200, arrival: 1900)
        XCTAssertFalse(TransitBenefitPolicy.isWorthwhile(laterButShorter, comparedTo: direct, timing: .leaveNow))
    }

    func testTransitBenefitRequiresBothDistanceThresholdsAndLimitsExtraTime() {
        let long = benefitJourney(id: "direct", direct: true, bikeMeters: 10000)
        for saving in [1999.0, 2000, 2001] {
            let route = benefitJourney(id: "transit", direct: false, bikeMeters: 10000 - saving)
            XCTAssertEqual(TransitBenefitPolicy.isWorthwhile(route, comparedTo: long, timing: .leaveNow), saving >= 2000)
        }
        let short = benefitJourney(id: "short", direct: true, bikeMeters: 4000)
        for saving in [999.0, 1000, 1001] {
            let route = benefitJourney(id: "transit", direct: false, bikeMeters: 4000 - saving)
            XCTAssertEqual(TransitBenefitPolicy.isWorthwhile(route, comparedTo: short, timing: .leaveNow), saving >= 1000)
        }
        for extra in [599.0, 600, 601] {
            let route = benefitJourney(id: "transit", direct: false, bikeMeters: 6000, arrival: 1800 + extra)
            XCTAssertEqual(TransitBenefitPolicy.isWorthwhile(route, comparedTo: long, timing: .leaveNow), extra <= 600)
        }
    }

    func testTransitBenefitArriveByUsesDepartureGainAndEarlierDepartureLimit() {
        let direct = benefitJourney(id: "direct", direct: true, bikeMeters: 8000)
        let timing = RouteTiming.arriveBy(date("2026-09-04T08:30:00Z"))
        for gain in [179.0, 180, 181] {
            let route = benefitJourney(id: "transit", direct: false, bikeMeters: 7900, departure: gain)
            XCTAssertEqual(TransitBenefitPolicy.isWorthwhile(route, comparedTo: direct, timing: timing), gain >= 180)
        }
        for earlier in [599.0, 600, 601] {
            let route = benefitJourney(id: "transit", direct: false, bikeMeters: 6000, departure: -earlier)
            XCTAssertEqual(TransitBenefitPolicy.isWorthwhile(route, comparedTo: direct, timing: timing), earlier <= 600)
        }
    }

    func testUselessBusIsNotUsedToFillCardsAndMissingReferenceKeepsTransit() {
        let direct = benefitJourney(id: "direct", direct: true, bikeMeters: 8000)
        let bus = benefitJourney(id: "one-minute-bus", direct: false, bikeMeters: 7600, arrival: 2100)
        let useful = benefitJourney(id: "useful", direct: false, bikeMeters: 6000, arrival: 1900)
        let selected = JourneyOptionSelector.select(from: [bus, direct, useful], timing: .leaveNow)
        XCTAssertEqual(selected.map(\.id), ["direct", "useful"])
        XCTAssertEqual(JourneyOptionSelector.select(from: [bus, direct], timing: .leaveNow).map(\.id), ["direct"])
        XCTAssertEqual(JourneyOptionSelector.select(from: [bus], timing: .leaveNow).map(\.id), ["one-minute-bus"])
        // A short transit ride with a large detour saving remains eligible.
        XCTAssertTrue(TransitBenefitPolicy.isWorthwhile(useful, comparedTo: direct, timing: .leaveNow))
    }

    func testBenefitUsesBestDirectBeforeDisplayToleranceAndNeverPrunesSearchSeeds() {
        let fastBike = benefitJourney(id: "fast-bike", direct: true, bikeMeters: 8000)
        let slowBike = benefitJourney(id: "slow-bike", direct: true, bikeMeters: 10000, arrival: 2200)
        let useless = benefitJourney(id: "weak-seed", direct: false, bikeMeters: 7800, arrival: 1900)
        XCTAssertFalse(JourneyOptionSelector.select(from: [slowBike, useless, fastBike], timing: .leaveNow).contains { $0.id == useless.id })
        XCTAssertEqual(JourneyOptionSelector.select(from: [useless], timing: .leaveNow).first?.id, useless.id)
        let veryFast = benefitJourney(id: "fast-transit", direct: false, bikeMeters: 6000, arrival: 600)
        XCTAssertEqual(JourneyOptionSelector.select(from: [fastBike, useless, veryFast], timing: .leaveNow).map(\.id), ["fast-transit"])
    }
}

extension FoldRouteTests {
    func testTransitPublishesBeforeDirectReferenceIncludingEmptyAndFailedReference() async throws {
        for outcome in ["success", "empty", "failure"] {
            let (client, gate) = gatedClient()
            let request = makeRequest()
            var settings = NavigationSettings.defaults
            settings.maxBikeTransfers = 0
            let task = Task {
                for try await update in client.alternativeUpdates(request, settings: settings) { gate.record(update) }
            }
            try await awaitGate { gate.counts.active == 2 }
            XCTAssertTrue(gate.finishNext(direct: false))
            try await awaitGate { gate.counts.started == 3 }
            // WALK/WALK may return no usable fixture. Finish BIKE/BIKE while the direct query stays pending.
            XCTAssertTrue(gate.finishNext(direct: false))
            try await awaitGate { !gate.values.isEmpty }
            XCTAssertTrue(gate.values.contains { $0.journeys.contains { !$0.isDirect } })
            XCTAssertTrue(gate.finishNext(direct: true, status: outcome == "failure" ? 500 : 200,
                                          data: outcome == "empty" ? TransitousFixtures.empty : nil))
            try await awaitGate { gate.counts.started >= 4 && !gate.values.isEmpty }
            XCTAssertTrue(gate.finishNext())
            try await awaitGate { gate.counts.started == 5 }
            while gate.finishNext() {}
            try await task.value
            let last = try XCTUnwrap(gate.values.last)
            XCTAssertEqual(last.status, outcome == "failure" ? .partial : .complete)
            XCTAssertFalse(JourneyOptionSelector.select(from: last.journeys, timing: request.timing).isEmpty)
            XCTAssertLessThanOrEqual(gate.counts.peak, 2)
        }
    }
}

extension FoldRouteTests {
    @MainActor
    private func settingsModel(planner: any JourneyPlanning,
                               location: (@MainActor () async -> CLLocation?)? = nil) throws -> (AppModel, SwiftDataJourneyStore) {
        let store = try makeHomeStore()
        let model = try AppModel(planner: planner, store: store, location: LocationService(),
                                 guidance: GuidanceService(), planningLocationProvider: location)
        let route = makeJourney()
        model.origin = route.origin
        model.destination = route.destination
        model.journey = route
        model.journeyOptions = [route]
        model.planningState = .ready
        try store.saveActiveJourney(route)
        return (model, store)
    }

    @MainActor
    func testRoutingSettingsInvalidateImmediatelyAndBatchOnExit() async throws {
        let planner = RecordingJourneyPlanner()
        let (model, store) = try settingsModel(planner: planner)
        let origin = model.origin
        let destination = model.destination
        let future = Date().addingTimeInterval(3600)
        model.timingSelection = .arrive
        model.plannedDate = future
        model.settings.maxWalkingMinutes = 5
        XCTAssertNil(model.journey)
        XCTAssertTrue(model.journeyOptions.isEmpty)
        XCTAssertNil(try store.loadActiveJourney())
        model.settings.foldingDuration = 90
        model.settings.cyclingSpeedKilometersPerHour = 20
        model.saveSettings()
        let before = await planner.recordedRequests()
        XCTAssertTrue(before.isEmpty)
        let task = try XCTUnwrap(model.finishSettingsEditing())
        XCTAssertNil(model.finishSettingsEditing())
        await task.value
        let requests = await planner.recordedRequests()
        let settings = await planner.recordedSettings()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.origin, origin)
        XCTAssertEqual(requests.first?.destination, destination)
        XCTAssertEqual(requests.first?.timing, .arriveBy(future))
        XCTAssertEqual(settings.first, model.settings)
        XCTAssertEqual(model.planningState, .ready)
        XCTAssertNotNil(model.journey)
        XCTAssertNil(model.finishSettingsEditing())
    }

    @MainActor
    func testEachRoutingFieldInvalidatesButAudioAndUnchangedSettingsDoNot() throws {
        let changes: [(inout NavigationSettings) -> Void] = [
            { $0.cyclingSpeedKilometersPerHour += 1 }, { $0.maxWalkingMinutes += 1 },
            { $0.foldingDuration += 30 },
            { $0.excludedTransitModes.insert(.bus) }, { $0.maxBikeTransfers += 1 },
            { $0.maxCyclingMinutes += 1 }, { $0.showCyclingComparison.toggle() }
        ]
        for change in changes {
            let (model, _) = try settingsModel(planner: UnusedJourneyPlanner())
            change(&model.settings)
            XCTAssertNil(model.journey)
            XCTAssertTrue(model.isPreviewReplan)
            model.discardRoute()
            XCTAssertNil(model.finishSettingsEditing())
        }
        let (model, _) = try settingsModel(planner: UnusedJourneyPlanner())
        let original = model.journey
        model.settings.audioEnabled.toggle()
        model.settings.hapticsEnabled.toggle()
        let unchanged = model.settings
        model.settings = unchanged
        XCTAssertEqual(model.journey, original)
        XCTAssertNil(model.finishSettingsEditing())
        model.discardRoute()
        model.settings.maxWalkingMinutes += 1
        XCTAssertNil(model.finishSettingsEditing())
    }

    @MainActor
    func testSettingsFailureRetryKeepsExplicitOriginAndDepartureTime() async throws {
        let planner = ReturnAlternativesPlanner(count: 1, failFirst: true)
        let (model, _) = try settingsModel(planner: planner)
        let start = model.origin
        let end = model.destination
        let future = Date().addingTimeInterval(3600)
        model.timingSelection = .depart
        model.plannedDate = future
        model.settings.maxWalkingMinutes += 1
        await model.finishSettingsEditing()?.value
        guard case .failed = model.planningState else { return XCTFail("Expected failure") }
        XCTAssertNil(model.journey)
        await model.retryPreviewPlanning()?.value
        let requests = await planner.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.origin == start && $0.destination == end && $0.timing == .departAt(future) })
        XCTAssertEqual(model.planningState, .ready)
    }

    @MainActor
    func testSettingsReplanRefreshesCurrentDestinationAndNowTiming() async throws {
        let planner = RecordingJourneyPlanner()
        let current = CLLocation(latitude: 48.2, longitude: 11.7)
        let (model, _) = try settingsModel(planner: planner, location: { current })
        let explicitStart = model.origin
        model.destination = Place(name: "Aktueller Standort", coordinate: Coordinate(latitude: 48.1, longitude: 11.6))
        model.settings.maxWalkingMinutes += 1
        await model.finishSettingsEditing()?.value
        let requests = await planner.recordedRequests()
        XCTAssertEqual(requests.first?.origin, explicitStart)
        XCTAssertEqual(requests.first?.destination.coordinate, Coordinate(current.coordinate))
        assertFrozenNow(try XCTUnwrap(requests.first).timing)
    }

    @MainActor
    func testPastFixedTimeDoesNotSilentlyChangeToNow() async throws {
        let planner = RecordingJourneyPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let past = Date().addingTimeInterval(-60)
        model.timingSelection = .depart
        model.plannedDate = past
        model.settings.maxWalkingMinutes += 1
        await model.finishSettingsEditing()?.value
        guard case .failed = model.planningState else { return XCTFail("Expected expired-time error") }
        XCTAssertEqual(model.plannedDate, past)
        XCTAssertEqual(model.timingSelection, .depart)
        let requests = await planner.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    @MainActor
    func testRoutingSettingsLeaveStartedNavigationIntact() throws {
        let (model, store) = try makeReturnPlanningModel(planner: UnusedJourneyPlanner(), locationProvider: { nil })
        let engine = model.navigation
        let route = model.journey
        model.settings.maxWalkingMinutes += 1
        XCTAssertTrue(model.navigation === engine)
        XCTAssertEqual(model.journey, route)
        XCTAssertNotNil(try store.loadActiveSnapshot()?.progress)
        XCTAssertNil(model.finishSettingsEditing())
        model.stopNavigation(discardRoute: true)
    }
}

private final class SettingsStreamPlanner: JourneyPlanning, @unchecked Sendable {
    private let lock = NSLock()
    private var streams: [AsyncThrowingStream<JourneyOptionsUpdate, Error>.Continuation] = []
    private var terminated: Set<Int> = []
    var count: Int { lock.withLock { streams.count } }
    func cancelled(_ index: Int) -> Bool { lock.withLock { terminated.contains(index) } }
    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey { throw RoutePlannerError.noRoute }
    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey { throw RoutePlannerError.noRoute }
    func alternativeUpdates(_ request: RouteRequest, settings: NavigationSettings) -> AsyncThrowingStream<JourneyOptionsUpdate, Error> {
        AsyncThrowingStream { continuation in
            let index = lock.withLock { let index = streams.count; streams.append(continuation); return index }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                _ = lock.withLock { terminated.insert(index) }
            }
        }
    }
    func fail(_ index: Int) {
        let stream = lock.withLock { streams[index] }
        stream.finish(throwing: RoutePlannerError.noRoute)
    }
    func emit(_ index: Int, journey: Journey, complete: Bool = true) {
        let stream = lock.withLock { streams[index] }
        stream.yield(JourneyOptionsUpdate(journeys: [journey], status: complete ? .complete : .searching))
        if complete { stream.finish() }
    }
}

extension FoldRouteTests {
    @MainActor
    func testHiddenInitialComparisonWaitsForEligibleStreamResult() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        model.settings.showCyclingComparison = false
        let task = Task { await model.planRoute() }
        try await awaitGate { planner.count == 1 }
        planner.emit(0, journey: benefitJourney(id: "hidden", direct: true, bikeMeters: 10000, arrival: 2760), complete: false)
        planner.emit(0, journey: makeJourney(id: "eligible"))
        await task.value
        XCTAssertEqual(model.journey?.id, "eligible")
    }

    @MainActor
    func testSettingsCancelFirstRequestAndRejectLateResult() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let first = Task { await model.planRoute() }
        try await awaitGate { planner.count == 1 }
        model.settings.maxWalkingMinutes += 1
        await first.value
        try await awaitGate { planner.cancelled(0) }
        planner.emit(0, journey: makeJourney(id: "stale"))
        XCTAssertNil(model.journey)
        let replacement = try XCTUnwrap(model.finishSettingsEditing())
        try await awaitGate { planner.count == 2 }
        planner.emit(1, journey: makeJourney(id: "fresh"))
        await replacement.value
        XCTAssertEqual(model.journey?.id, "fresh")
    }

    @MainActor
    func testRepeatedSettingsChangesCancelReplacementAndDiscardCancelsPendingWork() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        model.settings.maxWalkingMinutes += 1
        let first = try XCTUnwrap(model.finishSettingsEditing())
        try await awaitGate { planner.count == 1 }
        model.settings.foldingDuration += 30
        await first.value
        try await awaitGate { planner.cancelled(0) }
        XCTAssertNil(model.journey)
        let second = try XCTUnwrap(model.finishSettingsEditing())
        try await awaitGate { planner.count == 2 }
        model.discardRoute()
        await second.value
        try await awaitGate { planner.cancelled(1) }
        planner.emit(1, journey: makeJourney(id: "late"))
        XCTAssertNil(model.journey)
        XCTAssertNil(model.destination)
        XCTAssertNil(model.finishSettingsEditing())
    }

    @MainActor
    func testSettingsCancelProgressiveSearchWithoutRestoringOldCards() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let first = Task { await model.planRoute() }
        try await awaitGate { planner.count == 1 }
        planner.emit(0, journey: makeJourney(id: "initial"), complete: false)
        await first.value
        XCTAssertEqual(model.journey?.id, "initial")
        model.settings.maxBikeTransfers = 0
        try await awaitGate { planner.cancelled(0) }
        planner.emit(0, journey: makeJourney(id: "late-alternative"))
        XCTAssertNil(model.journey)
        XCTAssertTrue(model.journeyOptions.isEmpty)
        model.discardRoute()
    }
}


extension FoldRouteTests {
    private func assertFrozenNow(_ timing: RouteTiming, file: StaticString = #filePath, line: UInt = #line) {
        guard case .departAt(let captured) = timing else {
            XCTFail("Expected a fixed request timestamp", file: file, line: line)
            return
        }
        XCTAssertLessThan(abs(captured.timeIntervalSinceNow), 10, file: file, line: line)
    }

    func testLateDepartureThresholdAndArrivalExemption() {
        let requested = date("2026-09-07T21:30:00Z")
        XCTAssertNil(LateDeparturePolicy.delay(departure: requested.addingTimeInterval(3599), timing: .departAt(requested)))
        XCTAssertEqual(LateDeparturePolicy.delay(departure: requested.addingTimeInterval(3600), timing: .departAt(requested)), 3600)
        XCTAssertEqual(LateDeparturePolicy.delay(departure: requested.addingTimeInterval(86400), timing: .departAt(requested)), 86400)
        XCTAssertNil(LateDeparturePolicy.delay(departure: requested.addingTimeInterval(-1), timing: .departAt(requested)))
        XCTAssertNil(LateDeparturePolicy.delay(departure: requested, timing: .arriveBy(requested.addingTimeInterval(7200))))
        XCTAssertNil(LateDeparturePolicy.delay(departure: requested, timing: nil))
    }

    @MainActor
    func testCyclingLimitPersistenceAndDefaults() throws {
        let store = try makeHomeStore()
        var settings = NavigationSettings.defaults
        XCTAssertEqual(settings.maxCyclingMinutes, 30)
        settings.maxCyclingMinutes = 60
        try store.saveSettings(settings)
        XCTAssertEqual(try store.loadSettings().maxCyclingMinutes, 60)
        XCTAssertEqual(try JSONDecoder().decode(NavigationSettings.self, from: JSONEncoder().encode(settings)), settings)
        XCTAssertEqual(try JSONDecoder().decode(NavigationSettings.self, from: Data("{}".utf8)).maxCyclingMinutes, 30)
        let stored = StoredSettings()
        stored.maxCyclingMinutes = nil
        XCTAssertEqual(stored.value.maxCyclingMinutes, 30)
        stored.maxCyclingMinutes = 90
        XCTAssertEqual(stored.value.maxCyclingMinutes, 60)
        stored.maxCyclingMinutes = 0
        XCTAssertEqual(stored.value.maxCyclingMinutes, 1)
    }

    @MainActor
    func testLateHintWaitsForSearchAndUsesEachAlternative() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let route = makeJourney()
        let requested = route.departure.addingTimeInterval(-7200)
        model.timingSelection = .depart
        model.plannedDate = requested
        let task = Task { await model.planRoute() }
        try await awaitGate { planner.count == 1 }
        planner.emit(0, journey: route, complete: false)
        await task.value
        XCTAssertEqual(model.previewTiming, .departAt(requested))
        XCTAssertNil(model.lateDepartureDelay(for: route))
        planner.emit(0, journey: route)
        for _ in 0..<100 where model.bikeTransferSearchStatus == .searching { await Task.yield() }
        XCTAssertEqual(model.lateDepartureDelay(for: route), 7200)
        let early = route.replacingLegs(route.legs.map { $0.shifted(by: -7100) })
        model.journeyOptions = [route, early]
        model.selectJourney(at: 1)
        XCTAssertNil(model.lateDepartureDelay(for: early))
        model.selectJourney(at: 0)
        model.bikeTransferSearchStatus = .partial
        XCTAssertEqual(model.lateDepartureDelay(for: route), 7200)
        model.discardRoute()
        XCTAssertNil(model.previewTiming)
        XCTAssertNil(model.lateDepartureDelay(for: route))
    }

    @MainActor
    func testNowContextIsSharedWithProviderAndNewSettingsReplan() async throws {
        let planner = RecordingJourneyPlanner()
        let (model, _) = try settingsModel(planner: planner)
        await model.planRoute()
        let recorded = await planner.recordedRequests()
        let first = try XCTUnwrap(recorded.first)
        XCTAssertEqual(model.previewTiming, first.timing)
        assertFrozenNow(first.timing)
        model.settings.maxCyclingMinutes = 60
        XCTAssertNil(model.journey)
        await model.finishSettingsEditing()?.value
        let requests = await planner.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(model.previewTiming, requests.last?.timing)
        let usedSettings = await planner.recordedSettings()
        XCTAssertEqual(usedSettings.last?.maxCyclingMinutes, 60)
    }
}


extension FoldRouteTests {
    func testBikeTransferQueriesUseSharedCyclingLimit() async throws {
        for backwards in [false, true] {
            let recorder = RequestRecorder()
            let client = makeClient(recorder: recorder) { [self] request in
                guard queryValue("preTransitModes", in: request) == "BIKE",
                      queryValue("postTransitModes", in: request) == "BIKE" else { return TransitousFixtures.empty }
                return try accessFixture(pre: "BIKE", post: "BIKE")
            }
            var settings = NavigationSettings.defaults
            settings.maxCyclingMinutes = 10
            settings.maxBikeTransfers = 1
            let original = makeRequest()
            let request = RouteRequest(origin: original.origin, destination: original.destination,
                                       timing: backwards ? .arriveBy(date("2026-09-04T09:00:00Z")) : original.timing)
            _ = try await client.planAlternatives(request, settings: settings)
            let internalKey = backwards ? "maxPostTransitTime" : "maxPreTransitTime"
            let outerKey = backwards ? "maxPreTransitTime" : "maxPostTransitTime"
            let parts = recorder.requests.filter { queryValue(internalKey, in: $0) == "600" }
            XCTAssertFalse(parts.isEmpty)
            let outerModeKey = backwards ? "preTransitModes" : "postTransitModes"
            XCTAssertTrue(parts.contains { queryValue(outerModeKey, in: $0) == "BIKE" })
            for part in parts {
                let limit = queryValue(outerModeKey, in: part) == "WALK" ? "120" : "600"
                XCTAssertEqual(queryValue(outerKey, in: part), limit)
            }
        }
    }
}


extension FoldRouteTests {
    @MainActor
    func testFailedAdjustmentRetainsHintContextAndDiscardRejectsStaleContext() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let route = makeJourney()
        let requested = route.departure.addingTimeInterval(-7200)
        model.timingSelection = .depart
        model.plannedDate = requested
        let initial = Task { await model.planRoute() }
        try await awaitGate { planner.count == 1 }
        planner.emit(0, journey: route)
        await initial.value
        let edit = Task { await model.applyRouteAdjustments(origin: route.origin, destination: route.destination,
            timingSelection: .depart, plannedDate: Date().addingTimeInterval(7200)) }
        try await awaitGate { planner.count == 2 }
        planner.fail(1)
        let error = await edit.value
        XCTAssertNotNil(error)
        XCTAssertEqual(model.previewTiming, .departAt(requested))
        XCTAssertEqual(model.lateDepartureDelay(for: route), 7200)
        let pending = Task { await model.planRoute() }
        try await awaitGate { planner.count == 3 }
        model.discardRoute()
        planner.emit(2, journey: route)
        await pending.value
        XCTAssertNil(model.previewTiming)
        XCTAssertNil(model.journey)
    }
}


extension FoldRouteTests {
    @MainActor
    func testManualRefreshPreservesExplicitEndpointsTimingAndSettings() async throws {
        for timing in [TimingSelection.depart, .arrive, .now] {
            let planner = RecordingJourneyPlanner()
            let (model, store) = try settingsModel(planner: planner)
            let start = model.origin
            let destination = model.destination
            let settings = model.settings
            let future = Date().addingTimeInterval(7200)
            model.timingSelection = timing
            model.plannedDate = future
            let task = try XCTUnwrap(model.refreshPlannedRoutes())
            XCTAssertTrue(model.isPreviewReplan)
            XCTAssertNil(model.journey)
            XCTAssertTrue(model.journeyOptions.isEmpty)
            XCTAssertNil(try store.loadActiveJourney())
            XCTAssertNil(model.refreshPlannedRoutes())
            XCTAssertNil(model.finishSettingsEditing())
            await task.value
            let requests = await planner.recordedRequests()
            let request = try XCTUnwrap(requests.first)
            XCTAssertEqual(requests.count, 1)
            XCTAssertEqual(request.origin, start)
            XCTAssertEqual(request.destination, destination)
            if timing == .now { assertFrozenNow(request.timing) }
            else { XCTAssertEqual(request.timing, timing == .depart ? .departAt(future) : .arriveBy(future)) }
            XCTAssertEqual(model.previewTiming, request.timing)
            XCTAssertEqual(model.settings, settings)
            XCTAssertEqual(model.timingSelection, timing)
            XCTAssertEqual(model.plannedDate, future)
            XCTAssertFalse(model.isPreviewReplan)
            XCTAssertEqual(model.planningState, .ready)
            XCTAssertEqual(model.journey, model.journeyOptions.first)
        }
    }

    @MainActor
    func testManualRefreshUpdatesCurrentEndpointsAndRejectsMissingLocation() async throws {
        let current = CLLocation(latitude: 48.2, longitude: 11.7)
        for target in [SearchTarget.origin, .destination] {
            let planner = RecordingJourneyPlanner()
            let (model, _) = try settingsModel(planner: planner, location: { current })
            let place = Place(name: "Aktueller Standort", coordinate: Coordinate(latitude: 48.1, longitude: 11.6))
            if target == .origin { model.origin = place } else { model.destination = place }
            await model.refreshPlannedRoutes()?.value
            let requests = await planner.recordedRequests()
            XCTAssertEqual(target == .origin ? requests.first?.origin.coordinate : requests.first?.destination.coordinate,
                           Coordinate(current.coordinate))
        }
        let planner = RecordingJourneyPlanner()
        let (model, _) = try settingsModel(planner: planner, location: { nil })
        model.origin = Place(name: "Aktueller Standort", coordinate: Coordinate(latitude: 48.1, longitude: 11.6))
        let destination = model.destination
        await model.refreshPlannedRoutes()?.value
        guard case .failed = model.planningState else { return XCTFail("Missing location must fail") }
        XCTAssertTrue(model.isPreviewReplan)
        XCTAssertEqual(model.destination, destination)
        let requests = await planner.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    @MainActor
    func testManualRefreshFailureRetryAndDiscardRejectLateResults() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let origin = model.origin
        let destination = model.destination
        let refresh = try XCTUnwrap(model.refreshPlannedRoutes())
        try await awaitGate { planner.count == 1 }
        planner.fail(0)
        await refresh.value
        XCTAssertTrue(model.isPreviewReplan)
        XCTAssertNotNil(model.journey)
        XCTAssertFalse(model.journeyOptions.isEmpty)
        XCTAssertEqual(model.origin, origin)
        XCTAssertEqual(model.destination, destination)
        let retry = try XCTUnwrap(model.retryPreviewPlanning())
        try await awaitGate { planner.count == 2 }
        planner.emit(1, journey: makeJourney(id: "refreshed"))
        await retry.value
        XCTAssertEqual(model.journey?.id, "refreshed")
        let pending = try XCTUnwrap(model.refreshPlannedRoutes())
        try await awaitGate { planner.count == 3 }
        model.discardRoute()
        await pending.value
        planner.emit(2, journey: makeJourney(id: "obsolete"))
        XCTAssertNil(model.journey)
        XCTAssertNil(model.destination)
        XCTAssertFalse(model.isPreviewReplan)
    }

    @MainActor
    func testManualRefreshCancelsProgressiveSearchAndRejectsExpiredDate() async throws {
        let planner = SettingsStreamPlanner()
        let (model, _) = try settingsModel(planner: planner)
        let initial = Task { await model.planRoute() }
        try await awaitGate { planner.count == 1 }
        planner.emit(0, journey: makeJourney(), complete: false)
        await initial.value
        let refresh = try XCTUnwrap(model.refreshPlannedRoutes())
        try await awaitGate { planner.count == 2 && planner.cancelled(0) }
        planner.emit(0, journey: makeJourney(id: "old-alternative"))
        planner.emit(1, journey: makeJourney(id: "new-alternative"))
        await refresh.value
        XCTAssertEqual(model.journey?.id, "new-alternative")
        model.timingSelection = .depart
        model.plannedDate = Date().addingTimeInterval(-60)
        let expired = model.plannedDate
        await model.refreshPlannedRoutes()?.value
        guard case .failed = model.planningState else { return XCTFail("Expired date must fail") }
        XCTAssertEqual(planner.count, 2)
        XCTAssertEqual(model.plannedDate, expired)
        XCTAssertTrue(model.isPreviewReplan)
    }
}

extension FoldRouteTests {
    private var geometrySettings: NavigationSettings {
        var settings = NavigationSettings.defaults
        settings.excludedTransitModes = Set(TransitModePreference.allCases)
        settings.maxBikeTransfers = 0
        return settings
    }

    private func geometryFixture(broken: Bool, mixed: Bool = false, arrival: String? = nil) throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: TransitousFixtures.directBike) as? [String: Any])
        var trip = try XCTUnwrap((root["direct"] as? [[String: Any]])?.first)
        let valid = trip
        var legs = try XCTUnwrap(trip["legs"] as? [[String: Any]])
        if broken {
            // Backward reconstruction: meeting point -> origin, destination -> meeting point.
            let geometry: [String: Any] = ["precision": 5, "points": TransitousFixtures.encode([
                (48.30, 11.50), (48.1320, 11.5760), (48.1750, 11.6000), (48.30, 11.50)
            ])]
            legs[0]["legGeometry"] = geometry
            legs[0]["steps"] = [["relativeDirection": "CONTINUE", "distance": 6800,
                                 "streetName": "Testweg", "polyline": geometry]]
            trip["id"] = "broken"
        }
        if let arrival {
            trip["endTime"] = arrival
            legs[0]["endTime"] = arrival
        }
        trip["legs"] = legs
        root["direct"] = mixed ? [valid, trip] : [trip]
        return try JSONSerialization.data(withJSONObject: root)
    }

    func testStreetGeometryRejectsWrongEndpointsAndDisconnectedTurns() throws {
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48, longitude: 11.3)
        let midpoint = Coordinate(latitude: 48, longitude: 11.15)
        XCTAssertGreaterThan(a.distance(to: b), 17_000)
        XCTAssertThrowsError(try StreetGeometryValidator.validated(
            coordinates: [midpoint, a, b, midpoint], steps: [], from: a, to: b, isWalk: false, distance: 22_000))
        XCTAssertThrowsError(try StreetGeometryValidator.validated(
            coordinates: [a, b], steps: [[a, midpoint], [b]], from: a, to: b, isWalk: false, distance: 22_000))
        // A genuinely straight rural road is valid even with widely spaced vertices.
        XCTAssertNoThrow(try StreetGeometryValidator.validated(
            coordinates: [a, b], steps: [[a, b]], from: a, to: b, isWalk: false, distance: 22_000))
    }

    func testStreetGeometryReconstructsMissingLineAndAllowsOnlyShortMissingWalks() throws {
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48, longitude: 11.01)
        let near = Coordinate(latitude: 48, longitude: 11.0001)
        XCTAssertEqual(try StreetGeometryValidator.validated(
            coordinates: [], steps: [[a, b]], from: a, to: b, isWalk: false, distance: 750), [a, b])
        XCTAssertEqual(try StreetGeometryValidator.validated(
            coordinates: [], steps: [], from: a, to: near, isWalk: true, distance: 10), [a, near])
        XCTAssertThrowsError(try StreetGeometryValidator.validated(
            coordinates: [], steps: [], from: a, to: b, isWalk: true, distance: 750))
        XCTAssertThrowsError(try StreetGeometryValidator.validated(
            coordinates: [a, Coordinate(latitude: .nan, longitude: 11), b], steps: [],
            from: a, to: b, isWalk: false, distance: 750))
        XCTAssertThrowsError(try PolylineDecoder.decode("??", precision: -1))
    }

    func testInvalidArrivalBikeRecomputesForwardAndKeepsReturnedTimes() async throws {
        let recorder = RequestRecorder()
        let bad = try geometryFixture(broken: true)
        let client = makeClient(recorder: recorder) { request in
            queryValue("arriveBy", in: request) == "true" ? bad : TransitousFixtures.directBike
        }
        let base = makeRequest()
        let request = RouteRequest(origin: base.origin, destination: base.destination,
                                   timing: .arriveBy(date("2026-09-04T09:00:00Z")))
        let result = try await client.planDirectBike(request, settings: geometrySettings)
        XCTAssertEqual(recorder.requests.count, 2)
        let retry = try XCTUnwrap(recorder.requests.last)
        XCTAssertEqual(queryValue("arriveBy", in: retry), "false")
        XCTAssertEqual(queryValue("time", in: retry), "2026-09-04T08:00:00Z")
        XCTAssertEqual(retry.cachePolicy, .reloadIgnoringLocalCacheData)
        for key in ["fromPlace", "toPlace", "cyclingSpeed", "directModes"] {
            XCTAssertEqual(queryValue(key, in: retry), queryValue(key, in: recorder.requests[0]))
        }
        XCTAssertEqual(result.departure, date("2026-09-04T08:00:00Z"))
        XCTAssertEqual(result.arrival, date("2026-09-04T08:32:00Z"))
        XCTAssertNoThrow(try StreetGeometryValidator.validate(result))
    }

    func testGeometryRecoveryRejectsLateArrivalAndNeverLoops() async throws {
        for late in [false, true] {
            let recorder = RequestRecorder()
            let bad = try geometryFixture(broken: true)
            let tooLate = try geometryFixture(broken: false, arrival: "2026-09-04T10:00:00Z")
            let client = makeClient(recorder: recorder) { request in
                queryValue("arriveBy", in: request) == "false" && late ? tooLate : bad
            }
            let base = makeRequest()
            let request = RouteRequest(origin: base.origin, destination: base.destination,
                                       timing: .arriveBy(date("2026-09-04T09:00:00Z")))
            do {
                _ = try await client.planDirectBike(request, settings: geometrySettings)
                XCTFail("Invalid or late geometry recovery must fail")
            } catch {
                XCTAssertEqual(error as? RoutePlannerError, .invalidRouteGeometry)
            }
            XCTAssertEqual(recorder.requests.count, 2)
        }
    }

    func testGeometryRetryPreservesValidSiblingWhenSecondResponseOmitsIt() async throws {
        let recorder = RequestRecorder()
        let mixed = try geometryFixture(broken: true, mixed: true)
        let client = makeClient(recorder: recorder) { request in
            request.cachePolicy == .reloadIgnoringLocalCacheData ? TransitousFixtures.empty : mixed
        }
        var updates: [JourneyOptionsUpdate] = []
        for try await update in client.alternativeUpdates(makeRequest(), settings: geometrySettings) {
            updates.append(update)
            XCTAssertEqual(update.journeys.map(\.id), ["bike-1"])
        }
        XCTAssertEqual(updates.last?.status, .partial)
        XCTAssertEqual(recorder.requests.count, 2)
        XCTAssertEqual(recorder.requests.first?.url, recorder.requests.last?.url)
    }

    func testGeometryRetryFiltersOnlyInvalidSibling() async throws {
        let recorder = RequestRecorder()
        let mixed = try geometryFixture(broken: true, mixed: true)
        let client = makeClient(recorder: recorder) { _ in mixed }
        let routes = try await client.planAlternatives(makeRequest(), settings: geometrySettings)
        XCTAssertEqual(routes.map(\.id), ["bike-1"])
        XCTAssertEqual(recorder.requests.count, 2)
    }

    func testGeometryRetryStopsOnRateLimit() async throws {
        let recorder = RequestRecorder()
        let bad = try geometryFixture(broken: true)
        let client = makeClient(recorder: recorder) { _ in bad }
        MockURLProtocol.handler = { request in
            recorder.append(request)
            let status = request.cachePolicy == .reloadIgnoringLocalCacheData ? 429 : 200
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, bad)
        }
        do {
            _ = try await client.planDirectBike(makeRequest(), settings: geometrySettings)
            XCTFail("Rate limit must stop recovery")
        } catch {
            XCTAssertEqual(error as? RoutePlannerError, .rateLimited)
        }
        XCTAssertEqual(recorder.requests.count, 2)
    }

    @MainActor
    func testInvalidStoredGeometryDoesNotRestoreOrStartNavigation() async throws {
        let store = try makeHomeStore()
        let base = makeJourney()
        guard case .bike(let leg) = base.legs[0] else { return XCTFail("Expected bike") }
        let invalid = MovementLeg(from: leg.from, to: leg.to, startTime: leg.startTime, endTime: leg.endTime,
                                  distance: leg.distance, coordinates: [leg.to.coordinate, leg.from.coordinate], maneuvers: [])
        let journey = Journey(id: "invalid", origin: base.origin, destination: base.destination,
                              departure: base.departure, arrival: base.arrival, legs: [.bike(invalid)],
                              transfers: 0, isDirect: true, score: base.score)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: journey, progress: NavigationProgress(legIndex: 0, maneuverIndex: 0)))
        let model = try AppModel(planner: UnusedJourneyPlanner(), store: store,
                                 location: LocationService(), guidance: GuidanceService())
        XCTAssertNil(model.navigation)
        XCTAssertNil(try store.loadActiveSnapshot())
        model.journey = journey
        await model.startNavigation()
        XCTAssertNil(model.navigation)
        XCTAssertEqual(model.navigationStartState, .failed(RoutePlannerError.invalidRouteGeometry.localizedDescription))
    }
}

extension FoldRouteTests {
    func testCancellingGeometryRecoveryStopsPendingRequestWithoutPublishingRoute() async throws {
        let (client, gate) = gatedClient()
        let request = makeRequest()
        let settings = geometrySettings
        let bad = try geometryFixture(broken: true)
        let task = Task { try await client.planDirectBike(request, settings: settings) }
        try await awaitGate { gate.counts.started == 1 }
        XCTAssertTrue(gate.finishNext(data: bad))
        try await awaitGate { gate.counts.started == 2 }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Cancelled recovery must not return a journey")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        try await awaitGate { gate.counts.active == 0 }
        XCTAssertEqual(gate.counts.started, 2)
        XCTAssertEqual(gate.counts.peak, 1)
    }

    func testStreetGeometryUsesOneHundredMeterEndpointTolerance() throws {
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48, longitude: 11.1)
        let snapped = Coordinate(latitude: 48.0004, longitude: 11)
        let tooFar = Coordinate(latitude: 48.002, longitude: 11)
        XCTAssertNoThrow(try StreetGeometryValidator.validated(
            coordinates: [snapped, b], steps: [[snapped, b]], from: a, to: b, isWalk: false, distance: 7500))
        XCTAssertThrowsError(try StreetGeometryValidator.validated(
            coordinates: [tooFar, b], steps: [[tooFar, b]], from: a, to: b, isWalk: false, distance: 7500))
    }
}

extension FoldRouteTests {
    func testElevatorStationWalkKeepsInstructionWithoutRetryOrPartialStatus() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { request in
            queryValue("directModes", in: request) == "BIKE" ? TransitousFixtures.empty : TransitousFixtures.elevatorWalk
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        var final: JourneyOptionsUpdate?
        for try await update in client.alternativeUpdates(makeRequest(), settings: settings) { final = update }
        XCTAssertEqual(final?.status, .complete)
        XCTAssertEqual(recorder.requests.count, 5)
        XCTAssertFalse(recorder.requests.contains { $0.cachePolicy == .reloadIgnoringLocalCacheData })
        let journey = try XCTUnwrap(final?.journeys.first)
        guard case .walk(let leg) = journey.legs.first else { return XCTFail("Expected station walk") }
        let elevator = try XCTUnwrap(leg.maneuvers.first { $0.direction == .elevator })
        XCTAssertEqual(elevator.instruction, "Aufzug nehmen")
        XCTAssertEqual(elevator.distance, 0)
        XCTAssertEqual(elevator.coordinates.count, 1)
        XCTAssertEqual(leg.distance, 36)
        XCTAssertEqual(leg.maneuvers.map(\.direction), [.straight, .elevator, .straight])
        XCTAssertNoThrow(try StreetGeometryValidator.validate(journey))
    }

    func testEmptyElevatorsAtBoundariesAndInGroupsReceiveAnchors() throws {
        typealias Step = StreetGeometryValidator.Step
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48, longitude: 11.0001)
        let lift = Step(direction: .elevator, distance: 0, streetName: "", coordinates: [])
        let road = Step(direction: .straight, distance: 10, streetName: "", coordinates: [a, b])
        for input in [[lift, road], [road, lift], [road, lift, lift, road], [lift], [lift, lift]] {
            let output = try StreetGeometryValidator.normalizedSteps(input, geometry: [a, b], from: a, to: b)
            XCTAssertEqual(output.count, input.count)
            XCTAssertTrue(output.allSatisfy { !$0.coordinates.isEmpty })
            XCTAssertEqual(output.map(\.direction), input.map(\.direction))
            XCTAssertNoThrow(try StreetGeometryValidator.validated(coordinates: [a, b],
                steps: output.map(\.coordinates), from: a, to: b, isWalk: true, distance: 10))
        }
        let fallback = try StreetGeometryValidator.normalizedSteps([lift], geometry: [], from: a, to: b)
        XCTAssertEqual(fallback[0].coordinates, [a])
    }

    func testEmptyElevatorsDoNotHideHorizontalGapsOrOtherMissingSteps() throws {
        typealias Step = StreetGeometryValidator.Step
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48, longitude: 11.001)
        let lift = Step(direction: .elevator, distance: 0, streetName: "", coordinates: [])
        let before = Step(direction: .straight, distance: 1, streetName: "", coordinates: [a])
        let after = Step(direction: .straight, distance: 1, streetName: "", coordinates: [b])
        XCTAssertGreaterThan(a.distance(to: b), 25)
        XCTAssertLessThan(a.distance(to: b), 100)
        for input in [[before, lift, after], [before, lift, lift, after], [lift]] {
            XCTAssertThrowsError(try StreetGeometryValidator.normalizedSteps(input, geometry: [a, b], from: a, to: b))
        }
        // Even a perfect anchor must not excuse another empty step type or positive distance.
        for step in [Step(direction: .straight, distance: 0, streetName: "", coordinates: []),
                     Step(direction: .stairs, distance: 0, streetName: "", coordinates: []),
                     Step(direction: .elevator, distance: 1, streetName: "", coordinates: [])] {
            XCTAssertThrowsError(try StreetGeometryValidator.normalizedSteps([step], geometry: [a, a], from: a, to: a))
        }
        XCTAssertThrowsError(try StreetGeometryValidator.normalizedSteps([lift], geometry: [],
            from: Coordinate(latitude: .nan, longitude: 11), to: b))
        // Ordinary elevator geometry is retained, including a nonzero horizontal distance.
        let ordinary = Step(direction: .elevator, distance: 75, streetName: "", coordinates: [a, b])
        XCTAssertEqual(try StreetGeometryValidator.normalizedSteps([ordinary], geometry: [a, b], from: a, to: b)[0].coordinates, [a, b])
    }

    @MainActor
    func testNormalizedElevatorSurvivesPersistenceAndNavigationRestore() async throws {
        let client = makeClient { request in
            queryValue("directModes", in: request) == "BIKE" ? TransitousFixtures.empty : TransitousFixtures.elevatorWalk
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        let journey = try await client.plan(makeRequest(), settings: settings)
        guard case .walk(let leg) = journey.legs.first else { return XCTFail("Expected walk") }
        let elevatorIndex = try XCTUnwrap(leg.maneuvers.firstIndex { $0.direction == .elevator })
        let progress = NavigationProgress(legIndex: 0, maneuverIndex: elevatorIndex)
        let store = try makeHomeStore()
        try store.saveSettings(settings)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: journey, progress: progress))
        let model = try AppModel(planner: UnusedJourneyPlanner(), store: store,
                                 location: LocationService(), guidance: GuidanceService())
        let engine = try XCTUnwrap(model.navigation)
        XCTAssertEqual(engine.currentManeuver?.instruction, "Aufzug nehmen")
        XCTAssertEqual(engine.currentManeuver?.coordinates.count, 1)
        XCTAssertEqual(try store.loadActiveSnapshot()?.progress, progress)
        XCTAssertNoThrow(try StreetGeometryValidator.validate(try XCTUnwrap(store.loadActiveSnapshot()).journey))
    }
}

extension FoldRouteTests {
    func testOnlyConfirmedStationEndpointsAllowUpToFiveHundredMeters() throws {
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48, longitude: 11.1)
        for meters in [111.0, 250, 450, 510] {
            let snapped = Coordinate(latitude: b.latitude + meters / 111_195, longitude: b.longitude)
            let points = [a, snapped]
            if meters < 500 {
                XCTAssertNoThrow(try StreetGeometryValidator.validated(coordinates: points, steps: [points],
                    from: a, to: b, isWalk: false, distance: 7500, toTransitStopID: "test:station"))
                XCTAssertNoThrow(try StreetGeometryValidator.validated(coordinates: Array(points.reversed()),
                    steps: [Array(points.reversed())], from: b, to: a, isWalk: true, distance: 7500,
                    fromTransitStopID: "test:station"))
            } else {
                XCTAssertThrowsError(try StreetGeometryValidator.validated(coordinates: points, steps: [points],
                    from: a, to: b, isWalk: false, distance: 7500, toTransitStopID: "test:station"))
            }
            for id in [nil, "", "   "] as [String?] {
                XCTAssertThrowsError(try StreetGeometryValidator.validated(coordinates: points, steps: [points],
                    from: a, to: b, isWalk: false, distance: 7500, toTransitStopID: id))
            }
        }
    }

    func testStationToleranceNeverRelaxesInternalStepGaps() {
        let a = Coordinate(latitude: 48, longitude: 11)
        let b = Coordinate(latitude: 48.001, longitude: 11)
        XCTAssertGreaterThan(a.distance(to: b), 100)
        XCTAssertThrowsError(try StreetGeometryValidator.validated(coordinates: [a, b], steps: [[a], [b]],
            from: a, to: b, isWalk: true, distance: 111,
            fromTransitStopID: "station:a", toTransitStopID: "station:b"))
        XCTAssertThrowsError(try StreetGeometryValidator.validated(coordinates: [], steps: [],
            from: a, to: b, isWalk: true, distance: 111,
            fromTransitStopID: "station:a", toTransitStopID: "station:b"))
    }

    private func stationEndpointFixture() throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: TransitousFixtures.multimodal) as? [String: Any])
        var trips = try XCTUnwrap(root["itineraries"] as? [[String: Any]])
        var legs = try XCTUnwrap(trips[0]["legs"] as? [[String: Any]])
        var station = try XCTUnwrap(legs[0]["to"] as? [String: Any])
        station["name"] = "Test Hbf"
        station["lat"] = try XCTUnwrap(station["lat"] as? Double) + 0.001
        station["stopId"] = "test:rail:platform"
        legs[0]["to"] = station
        legs[1]["from"] = station
        trips[0]["legs"] = legs
        root["itineraries"] = trips
        return try JSONSerialization.data(withJSONObject: root)
    }

    func testHbfEndpointOffsetDoesNotTriggerRetryOrPartialSearch() async throws {
        let recorder = RequestRecorder()
        let fixture = try stationEndpointFixture()
        let client = makeClient(recorder: recorder) { request in
            queryValue("directModes", in: request) == "BIKE" ? TransitousFixtures.empty : fixture
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        var final: JourneyOptionsUpdate?
        for try await update in client.alternativeUpdates(makeRequest(), settings: settings) { final = update }
        XCTAssertEqual(final?.status, .complete)
        XCTAssertEqual(recorder.requests.count, 5)
        XCTAssertFalse(recorder.requests.contains { $0.cachePolicy == .reloadIgnoringLocalCacheData })
        let journey = try XCTUnwrap(final?.journeys.first)
        guard case .bike(let leg) = journey.legs[0] else { return XCTFail("Expected access bike leg") }
        XCTAssertEqual(leg.to.transitStopID, "test:rail:platform")
        let end = try XCTUnwrap(leg.coordinates.last)
        XCTAssertGreaterThan(end.distance(to: leg.to.coordinate), 100)
        XCTAssertLessThan(end.distance(to: leg.to.coordinate), 115)
        XCTAssertEqual(leg.shifted(by: 60).to.transitStopID, leg.to.transitStopID)
        XCTAssertNoThrow(try StreetGeometryValidator.validate(journey.replacingLegs(journey.legs.map { $0.shifted(by: 60) })))
    }

    func testLegacyPlaceDecodingDefaultsToOrdinaryEndpoint() throws {
        let original = Place(name: "Hbf", coordinate: Coordinate(latitude: 48, longitude: 11))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        object.removeValue(forKey: "transitStopID")
        let restored = try JSONDecoder().decode(Place.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(restored.transitStopID)
        XCTAssertEqual(restored, original)
        XCTAssertNil(Place(name: "Station", coordinate: original.coordinate, transitStopID: " ").transitStopID)
    }

    @MainActor
    func testStationIdentitySurvivesNavigationRestore() async throws {
        let fixture = try stationEndpointFixture()
        let client = makeClient { request in
            queryValue("directModes", in: request) == "BIKE" ? TransitousFixtures.empty : fixture
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        settings.audioEnabled = false
        settings.hapticsEnabled = false
        let journey = try await client.plan(makeRequest(), settings: settings)
        let store = try makeHomeStore()
        try store.saveSettings(settings)
        let progress = NavigationProgress(legIndex: 0, maneuverIndex: 0)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: journey, progress: progress))
        let model = try AppModel(planner: UnusedJourneyPlanner(), store: store,
            location: LocationService(), guidance: GuidanceService())
        let engine = try XCTUnwrap(model.navigation)
        XCTAssertEqual(engine.journey.legs[0].endPlace.transitStopID, "test:rail:platform")
        XCTAssertEqual(try store.loadActiveSnapshot()?.progress, progress)
        XCTAssertNoThrow(try StreetGeometryValidator.validate(engine.journey))
    }
}

extension FoldRouteTests {
    func testPlanningFailuresKeepSpecificCauseForPartialAndTotalResults() async throws {
        let cases: [(Error, RoutePlannerError)] = [
            (URLError(.notConnectedToInternet), .offline),
            (URLError(.networkConnectionLost), .offline),
            (URLError(.timedOut), .timedOut)
        ]
        for (failure, expected) in cases {
            let client = makeClient { _ in throw failure }
            do {
                _ = try await client.planAlternatives(makeRequest(), settings: geometrySettings)
                XCTFail("Expected total failure")
            } catch { XCTAssertEqual(error as? RoutePlannerError, expected) }
        }
        for (failure, expected) in cases where expected != .rateLimited {
            let client = makeClient { request in
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                if query.contains(where: { $0.name == "transitModes" && $0.value == "" }) {
                    return TransitousFixtures.directBike
                }
                throw failure
            }
            var settings = NavigationSettings.defaults
            settings.maxBikeTransfers = 0
            var updates: [JourneyOptionsUpdate] = []
            for try await update in client.alternativeUpdates(makeRequest(), settings: settings) { updates.append(update) }
            XCTAssertEqual(updates.last?.status, .partial)
            XCTAssertEqual(updates.last?.issues, [expected])
            XCTAssertFalse(updates.last?.journeys.isEmpty ?? true)
        }
    }

    func testPlanningRetryAfterBlocksClientCopiesWithoutNetwork() async throws {
        for status in [429, 503] {
            let recorder = RequestRecorder()
            let client = makeClient { _ in TransitousFixtures.directBike }
            MockURLProtocol.handler = { request in
                recorder.append(request)
                return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                    headerFields: ["Retry-After": "60"])!, Data())
            }
            do {
                _ = try await client.planAlternatives(makeRequest(), settings: geometrySettings)
                XCTFail("Expected server pause")
            } catch {
                let issues = RoutePlannerError.unique([try XCTUnwrap(error as? RoutePlannerError)])
                XCTAssertTrue(issues.contains(status == 429 ? .rateLimited : .serviceUnavailable))
                XCTAssertTrue(issues.contains { if case .serverPause = $0 { true } else { false } })
            }
            let retryAt = try XCTUnwrap(client.planningPause.retryAt)
            XCTAssertGreaterThan(retryAt.timeIntervalSinceNow, 55)
            let copy = client
            do {
                _ = try await copy.planDirectBike(makeRequest(), settings: geometrySettings)
                XCTFail("Request during pause must fail")
            } catch { XCTAssertEqual(error as? RoutePlannerError, .serverPause(retryAt)) }
            XCTAssertEqual(recorder.requests.count, 1)
            XCTAssertThrowsError(try client.planningPause.check(now: retryAt.addingTimeInterval(-1)))
            XCTAssertNoThrow(try client.planningPause.check(now: retryAt))
        }
    }

    func testPlanningAbsentInvalidAndPastRetryAfterNeverInventPause() async throws {
        for header in [nil, "invalid", "-10", "0", "Mon, 07 Sep 2020 12:00:00 GMT"] as [String?] {
            for status in [429, 503] {
                let recorder = RequestRecorder()
                let client = makeClient { _ in TransitousFixtures.directBike }
                MockURLProtocol.handler = { request in
                    recorder.append(request)
                    return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                        headerFields: header.map { ["Retry-After": $0] })!, Data())
                }
                for _ in 0..<2 {
                    do {
                        _ = try await client.planDirectBike(makeRequest(), settings: geometrySettings)
                        XCTFail("Expected failure")
                    } catch { XCTAssertEqual(error as? RoutePlannerError, status == 429 ? .rateLimited : .serviceUnavailable) }
                }
                XCTAssertNil(client.planningPause.retryAt)
                XCTAssertEqual(recorder.requests.count, 2)
            }
        }
    }

    func testPlanningHTTPDatePauseAndExpiredPauseAllowManualRequest() async throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        let client = makeClient { _ in TransitousFixtures.directBike }
        let date = Date().addingTimeInterval(120)
        MockURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil,
                headerFields: ["Retry-After": formatter.string(from: date)])!, Data())
        }
        do { _ = try await client.planDirectBike(makeRequest(), settings: geometrySettings); XCTFail("Expected pause") }
        catch { XCTAssertTrue(RoutePlannerError.classify(error).stopsRequests) }
        XCTAssertEqual(try XCTUnwrap(client.planningPause.retryAt).timeIntervalSince1970,
                       date.timeIntervalSince1970, accuracy: 1.1)
        let recorder = RequestRecorder()
        let resumed = makeClient(recorder: recorder) { _ in TransitousFixtures.directBike }
        resumed.planningPause.record(retryAt: Date().addingTimeInterval(-1))
        _ = try await resumed.planDirectBike(makeRequest(), settings: geometrySettings)
        XCTAssertEqual(recorder.requests.count, 1)
    }

    func testPlanningIssueDeduplicationAndGeometryRecovery() async throws {
        XCTAssertEqual(RoutePlannerError.unique([.timedOut, .multiple([.rateLimited, .timedOut]), .offline]),
                       [.rateLimited, .timedOut, .offline])
        let recorder = RequestRecorder()
        let bad = try geometryFixture(broken: true)
        let client = makeClient(recorder: recorder) { _ in
            recorder.requests.count == 1 ? bad : TransitousFixtures.directBike
        }
        var updates: [JourneyOptionsUpdate] = []
        for try await update in client.alternativeUpdates(makeRequest(), settings: geometrySettings) { updates.append(update) }
        XCTAssertEqual(updates.last?.status, .complete)
        XCTAssertEqual(updates.last?.issues, [])
    }

    @MainActor
    func testKnownPlanningPausePreservesPreviewAndBlocksAllEntryPoints() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { _ in TransitousFixtures.directBike }
        let store = try makeHomeStore()
        let model = try AppModel(planner: client, store: store, location: LocationService(), guidance: GuidanceService())
        let journey = makeJourney()
        model.journey = journey
        model.journeyOptions = [journey]
        model.origin = journey.origin
        model.destination = journey.destination
        model.planningState = .ready
        client.planningPause.record(retryAt: Date().addingTimeInterval(60))
        XCTAssertTrue(model.planningRequestsPaused)
        XCTAssertNil(model.refreshPlannedRoutes())
        await model.planToDestination(journey.destination)
        await model.planRoute()
        let message = await model.applyRouteAdjustments(origin: journey.origin, destination: journey.destination,
            timingSelection: .now, plannedDate: Date())
        XCTAssertNotNil(message)
        XCTAssertEqual(model.journey, journey)
        XCTAssertEqual(model.journeyOptions, [journey])
        XCTAssertTrue(recorder.requests.isEmpty)
        model.planningIssues = [.timedOut, .timedOut, .rateLimited, .invalidRouteGeometry]
        let notice = try XCTUnwrap(model.planningNotice)
        XCTAssertEqual(notice.components(separatedBy: "Bereits gefundene Routen bleiben verfügbar.").count, 2)
        XCTAssertTrue(notice.contains("fehlerhafter Streckendaten"))
        XCTAssertFalse(model.canPlan)
    }
}


extension FoldRouteTests {
    func testHTTPFailuresAndUnreadableResponseHaveSpecificMessages() async throws {
        for (status, expected) in [(500, RoutePlannerError.serviceUnavailable), (200, .invalidResponse)] {
            for partial in [false, true] {
                let client = makeClient { _ in Data() }
                MockURLProtocol.handler = { request in
                    let direct = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                        .contains { $0.name == "directModes" && $0.value == "BIKE" }
                    let valid = partial && direct
                    return (HTTPURLResponse(url: request.url!, statusCode: valid ? 200 : status,
                        httpVersion: nil, headerFields: nil)!, valid ? TransitousFixtures.directBike : Data("invalid".utf8))
                }
                var settings = partial ? NavigationSettings.defaults : geometrySettings
                settings.maxBikeTransfers = 0
                var last: JourneyOptionsUpdate?
                do {
                    for try await update in client.alternativeUpdates(makeRequest(), settings: settings) { last = update }
                    XCTAssertTrue(partial)
                    XCTAssertEqual(last?.issues, [expected])
                } catch {
                    XCTAssertFalse(partial)
                    XCTAssertEqual(error as? RoutePlannerError, expected)
                }
            }
        }
    }

    func testMixedFailuresAreDeduplicatedAndPreserveValidRoutes() async throws {
        let (client, gate) = gatedClient()
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let request = makeRequest()
        let task = Task {
            for try await update in client.alternativeUpdates(request, settings: settings) { gate.record(update) }
        }
        try await awaitGate { gate.counts.active == 2 }
        XCTAssertTrue(gate.finishNext(direct: true))
        try await awaitGate { gate.counts.started == 3 }
        XCTAssertTrue(gate.finishNext(status: 500))
        try await awaitGate { gate.counts.started == 4 }
        XCTAssertTrue(gate.finishNext(status: 200, data: Data("invalid".utf8)))
        try await awaitGate { gate.counts.started == 5 }
        while gate.finishNext(status: 500) {}
        try await task.value
        XCTAssertEqual(gate.values.last?.issues, [.serviceUnavailable, .invalidResponse])
        XCTAssertFalse(gate.values.last?.journeys.isEmpty ?? true)
    }
}


extension FoldRouteTests {
    @MainActor
    func testPlanningPauseExpiresWithoutAutomaticRequest() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { _ in TransitousFixtures.directBike }
        let model = try AppModel(planner: client, store: makeHomeStore(), location: LocationService(), guidance: GuidanceService())
        model.origin = makeRequest().origin
        model.destination = makeRequest().destination
        model.settings = geometrySettings
        client.planningPause.record(retryAt: Date().addingTimeInterval(0.1))
        XCTAssertFalse(model.canPlan)
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertTrue(model.canPlan)
        XCTAssertNil(model.planningPauseMessage)
        XCTAssertTrue(recorder.requests.isEmpty)
        await model.planRoute()
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertNotNil(model.journey)
    }
}

extension FoldRouteTests {
    func testPlanningLocationCentersInVisibleMapForDifferentPanelsAndOrientations() throws {
        let coordinate = Coordinate(latitude: 48.1498, longitude: 11.6577)
        for viewport in [CGSize(width: 430, height: 850), CGSize(width: 850, height: 430)] {
            for fraction in [0.25, 0.60, 0.78] {
                let insets = MapCameraInsets(top: 64, leading: 24,
                    bottom: viewport.height * fraction, trailing: 48)
                let rect = try XCTUnwrap(RouteCameraFitter.mapRect(coordinates: [coordinate],
                    viewportSize: viewport, insets: insets, minimumContentDimension: 400))
                let point = MKMapPoint(coordinate.clCoordinate)
                let x = (point.x - rect.minX) / rect.width * viewport.width
                let y = (point.y - rect.minY) / rect.height * viewport.height
                XCTAssertEqual(x, (insets.leading + viewport.width - insets.trailing) / 2, accuracy: 0.5)
                XCTAssertEqual(y, (insets.top + viewport.height - insets.bottom) / 2, accuracy: 0.5)
                XCTAssertLessThan(y, viewport.height - insets.bottom)
                XCTAssertGreaterThan(y, insets.top)
            }
        }
    }
}

extension FoldRouteTests {
    func testSharedFoldingTimeDecodesLegacyAndNewSettings() throws {
        for (json, expected) in [
            ("{}", 180.0),
            (#"{"foldDuration":60,"unfoldDuration":60}"#, 60),
            (#"{"foldDuration":60,"unfoldDuration":150}"#, 150),
            (#"{"foldDuration":240,"unfoldDuration":120}"#, 240),
            (#"{"unfoldDuration":90}"#, 90),
            (#"{"foldingDuration":90,"foldDuration":240,"unfoldDuration":120}"#, 90)
        ] {
            let settings = try JSONDecoder().decode(NavigationSettings.self, from: Data(json.utf8))
            XCTAssertEqual(settings.foldingDuration, expected)
            XCTAssertEqual(settings.foldDuration, expected)
            XCTAssertEqual(settings.unfoldDuration, expected)
            let encoded = try JSONEncoder().encode(settings)
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            XCTAssertEqual(fields["foldingDuration"] as? Double, expected)
            XCTAssertNil(fields["foldDuration"])
            XCTAssertNil(fields["unfoldDuration"])
            XCTAssertEqual(try JSONDecoder().decode(NavigationSettings.self, from: encoded), settings)
        }
    }

    @MainActor
    func testLegacyStoredFoldingTimesMergeAndSaveEqually() throws {
        let store = try makeHomeStore()
        for (fold, unfold, expected) in [(60.0, 60.0, 60.0), (240, 150, 240), (60, 90, 90)] {
            let legacy = StoredSettings()
            legacy.foldDuration = fold
            legacy.unfoldDuration = unfold
            let settings = legacy.value
            XCTAssertEqual(settings.foldingDuration, expected)
            legacy.update(settings)
            XCTAssertEqual(legacy.foldDuration, expected)
            XCTAssertEqual(legacy.unfoldDuration, expected)
            try store.saveSettings(settings)
            XCTAssertEqual(try store.loadSettings(), settings)
        }
    }

    func testSharedFoldingTimeShowsHalfMinutesPrecisely() {
        var settings = NavigationSettings.defaults
        for (seconds, label) in [(60.0, "1 Min."), (90, "1 Min. 30 Sek."), (150, "2 Min. 30 Sek."), (600, "10 Min.")] {
            settings.foldingDuration = seconds
            XCTAssertEqual(settings.foldingDurationLabel, label)
        }
    }

    func testTransitPlanningUsesSharedDurationForBothTransitions() async throws {
        let client = makeClient { request in
            let direct = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
                .contains { $0.name == "directModes" && $0.value == "BIKE" } == true
            return direct ? TransitousFixtures.directBike : TransitousFixtures.delfiPlatformCodes
        }
        var settings = NavigationSettings.defaults
        settings.foldingDuration = 90
        settings.maxBikeTransfers = 0
        var transitions: [JourneyLeg] = []
        for try await update in client.alternativeUpdates(makeRequest(), settings: settings) {
            transitions += update.journeys.flatMap(\.legs).filter { $0.kind == .fold || $0.kind == .unfold }
        }
        XCTAssertTrue(transitions.contains { $0.kind == .fold })
        XCTAssertTrue(transitions.contains { $0.kind == .unfold })
        for leg in transitions { XCTAssertEqual(leg.endTime.timeIntervalSince(leg.startTime), 90, accuracy: 0.01) }
    }
}

private func viaPlace(_ index: Int) -> Place {
    Place(name: "Ort \(index)", coordinate: Coordinate(latitude: 48 + Double(index)*0.01, longitude: 11.5))
}
private func viaRide(_ request: RouteRequest, minutes: Int = 20) -> Journey {
    let departure = request.timing.isArrival ? request.timing.date.addingTimeInterval(-Double(minutes*60)) : request.timing.date
    let arrival = departure.addingTimeInterval(Double(minutes*60))
    return Journey(id: "\(request.origin.name)|\(request.destination.name)|\(departure)",
        origin: request.origin, destination: request.destination, departure: departure, arrival: arrival,
        legs: [.bike(MovementLeg(from: request.origin, to: request.destination, startTime: departure, endTime: arrival,
            distance: 5_000, coordinates: [request.origin.coordinate, request.destination.coordinate], maneuvers: []))],
        transfers: 0, isDirect: true, score: arrival.timeIntervalSince1970)
}

extension FoldRouteTests {
    func testViaPlanningForwardAndBackwardWithUpToThreeStops() async throws {
        let time = Date().addingTimeInterval(86_400)
        for backward in [false, true] {
            for count in 1...3 {
                let stops = (1...count).map { RouteStop(id: "stop-\($0)", place: viaPlace($0), stayMinutes: 10) }
                let request = RouteRequest(origin: viaPlace(0), destination: viaPlace(count+1), timing: backward ? .arriveBy(time) : .departAt(time), stops: stops)
                var settings = NavigationSettings.defaults
                settings.maxBikeTransfers = 0
                let recorder = RoutingGate()
                try await ViaRoutePlanner.run(request, settings: settings, fetch: { part, _, budget in
                    _ = try await budget.take()
                    return JourneyOptionsUpdate(journeys: [viaRide(part)], status: .complete)
                }, emit: { recorder.record($0) })
                XCTAssertFalse(recorder.values.isEmpty)
                for update in recorder.values {
                    for journey in update.journeys {
                        XCTAssertEqual(journey.stops, stops)
                        XCTAssertEqual(journey.duration, Double((20*(count+1)+10*count)*60), accuracy: 0.01)
                        XCTAssertEqual(backward ? journey.arrival : journey.departure, time)
                        XCTAssertEqual(CyclingComparison.excess(journey, limit: 30), 0)
                    }
                }
            }
        }
    }

    func testViaRoundTripAndAdjacentStopValidation() async throws {
        let time = Date().addingTimeInterval(86_400)
        let stop = RouteStop(place: viaPlace(1))
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let record = RoutingGate()
        try await ViaRoutePlanner.run(RouteRequest(origin: viaPlace(0), destination: viaPlace(0), timing: .departAt(time), stops: [stop]), settings: settings,
            fetch: { request, _, _ in JourneyOptionsUpdate(journeys: [viaRide(request)], status: .complete) }, emit: { record.record($0) })
        XCTAssertEqual(record.values.last?.journeys.count, 1)
        do {
            try await ViaRoutePlanner.run(RouteRequest(origin: viaPlace(0), destination: viaPlace(2), timing: .departAt(time), stops: [RouteStop(place: viaPlace(0))]), settings: settings,
                fetch: { _, _, _ in XCTFail("Invalid input must not fetch"); throw RoutePlannerError.noRoute }, emit: { _ in })
            XCTFail("Expected invalid adjacent stop")
        } catch { XCTAssertEqual(error as? RoutePlannerError, .stopSection(1, .placesTooClose)) }
    }

    func testViaRejectsIncompleteJourneyAndInvalidStay() async throws {
        let request = RouteRequest(origin: viaPlace(0), destination: viaPlace(2), timing: .departAt(Date().addingTimeInterval(86_400)), stops: [RouteStop(place: viaPlace(1))])
        do {
            try await ViaRoutePlanner.run(request, settings: .defaults, fetch: { part, _, _ in
                if part.origin.coordinate == viaPlace(1).coordinate { throw RoutePlannerError.noRoute }
                return JourneyOptionsUpdate(journeys: [viaRide(part)], status: .complete)
            }, emit: { _ in XCTFail("Incomplete journeys must not be emitted") })
            XCTFail("Expected no complete journey")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Teilstrecke 2")) }
        XCTAssertThrowsError(try RouteStop.validate([RouteStop(place: viaPlace(1), stayMinutes: -1)]))
        XCTAssertThrowsError(try RouteStop.validate([RouteStop(place: viaPlace(1), stayMinutes: 1441)]))
    }

    func testViaComposerPreservesStopsAndPerSectionCyclingLimit() throws {
        let time = Date()
        let first = viaRide(RouteRequest(origin: viaPlace(0), destination: viaPlace(1), timing: .departAt(time)))
        let stop = RouteStop(place: viaPlace(1), stayMinutes: 10)
        let next = viaRide(RouteRequest(origin: viaPlace(1), destination: viaPlace(2), timing: .departAt(first.arrival.addingTimeInterval(600))))
        let combined = try XCTUnwrap(ViaJourneyComposer.join(first, next, at: stop))
        XCTAssertEqual(CyclingComparison.excess(combined, limit: 30), 0)
        XCTAssertEqual(combined.stops, [stop])
        let tooEarly = viaRide(RouteRequest(origin: viaPlace(1), destination: viaPlace(2), timing: .departAt(first.arrival.addingTimeInterval(599))))
        XCTAssertNil(ViaJourneyComposer.join(first, tooEarly, at: stop))
        let long = viaRide(RouteRequest(origin: viaPlace(1), destination: viaPlace(2), timing: .departAt(first.arrival.addingTimeInterval(600))), minutes: 35)
        XCTAssertEqual(CyclingComparison.excess(try XCTUnwrap(ViaJourneyComposer.join(first, long, at: stop)), limit: 30), 300)
    }

    @MainActor func testViaNavigationWaitsForManualContinueAndRestoresStop() throws {
        let first = viaRide(RouteRequest(origin: viaPlace(0), destination: viaPlace(1), timing: .departAt(Date())))
        let stop = RouteStop(place: viaPlace(1), stayMinutes: 10)
        let onward = viaRide(RouteRequest(origin: viaPlace(1), destination: viaPlace(2), timing: .departAt(first.arrival.addingTimeInterval(600))))
        let journey = try XCTUnwrap(ViaJourneyComposer.join(first, onward, at: stop))
        let snapshot = ActiveJourneySnapshot(journey: journey, progress: NavigationProgress(legIndex: 1, maneuverIndex: 0))
        let restored = try JSONDecoder().decode(ActiveJourneySnapshot.self, from: JSONEncoder().encode(snapshot))
        let engine = NavigationEngine(journey: restored.journey, settings: .defaults, guidance: GuidanceService())
        engine.start(progress: try XCTUnwrap(restored.progress))
        engine.tick(now: onward.arrival.addingTimeInterval(3600))
        XCTAssertEqual(engine.currentLeg?.kind, .stop)
        XCTAssertEqual(engine.journey.remainingStops(from: engine.currentLegIndex), [stop])
        let now = onward.departure.addingTimeInterval(300)
        let updated = try XCTUnwrap(engine.journeyAfterStop(now: now))
        engine.continueFromStop(with: updated, now: now)
        XCTAssertEqual(engine.currentLeg?.kind, .bike)
        XCTAssertEqual(engine.currentLeg?.startTime, now)
        XCTAssertTrue(engine.journey.remainingStops(from: engine.currentLegIndex).isEmpty)
    }

    @MainActor func testViaEarlyContinuationWaitsUntilPlannedDeparture() throws {
        let first = viaRide(RouteRequest(origin: viaPlace(0), destination: viaPlace(1), timing: .departAt(Date())))
        let stop = RouteStop(place: viaPlace(1), stayMinutes: 10)
        let onward = viaRide(RouteRequest(origin: viaPlace(1), destination: viaPlace(2), timing: .departAt(first.arrival.addingTimeInterval(600))))
        let journey = try XCTUnwrap(ViaJourneyComposer.join(first, onward, at: stop))
        let engine = NavigationEngine(journey: journey, settings: .defaults, guidance: GuidanceService())
        engine.start(progress: NavigationProgress(legIndex: 1, maneuverIndex: 0))
        let updated = try XCTUnwrap(engine.journeyAfterStop(now: first.arrival))
        engine.continueFromStop(with: updated, now: first.arrival)
        XCTAssertEqual(engine.currentLeg?.kind, .wait)
        XCTAssertEqual(engine.currentLeg?.endTime, onward.departure)
        XCTAssertTrue(engine.journey.remainingStops(from: engine.currentLegIndex).isEmpty)
    }

    @MainActor func testViaStoredHistoryAndLegacyRequest() throws {
        let request = RouteRequest(origin: viaPlace(0), destination: viaPlace(1), timing: .departAt(Date()))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        json.removeValue(forKey: "stops")
        XCTAssertEqual(try JSONDecoder().decode(RouteRequest.self, from: JSONSerialization.data(withJSONObject: json)).stops, [])
        let first = viaRide(request)
        let stop = RouteStop(place: viaPlace(1), stayMinutes: 10)
        let onward = viaRide(RouteRequest(origin: viaPlace(1), destination: viaPlace(2), timing: .departAt(first.arrival.addingTimeInterval(600))))
        let stored = try StoredJourney(journey: XCTUnwrap(ViaJourneyComposer.join(first, onward, at: stop)))
        XCTAssertEqual(try stored.decodedStops(), [stop])
        stored.stopsData = nil
        XCTAssertEqual(try stored.decodedStops(), [])
    }

    func testViaBudgetStopsAfter64Requests() async throws {
        let budget = WaypointRequestBudget()
        for _ in 0..<64 { _ = try await budget.take() }
        do { _ = try await budget.take(); XCTFail("Expected budget exhaustion") }
        catch { XCTAssertEqual(error as? RoutePlannerError, .stopBudget) }
    }
}

private actor ViaRecordingPlanner: JourneyPlanning {
    private var recorded: [RouteRequest] = []
    func requests() -> [RouteRequest] { recorded }
    func plan(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey {
        recorded.append(request)
        let places = [request.origin] + request.stops.map(\.place) + [request.destination]
        var combined: Journey?
        for i in 0..<(places.count-1) {
            let departure = combined.map { $0.arrival.addingTimeInterval(Double(request.stops[i-1].stayMinutes*60)) } ?? Date()
            let part = viaRide(RouteRequest(origin: places[i], destination: places[i+1], timing: .departAt(departure)))
            combined = combined.flatMap { ViaJourneyComposer.join($0, part, at: request.stops[i-1]) } ?? part
        }
        return combined!
    }
    func planDirectBike(_ request: RouteRequest, settings: NavigationSettings) async throws -> Journey { try await plan(request, settings: settings) }
}

extension FoldRouteTests {
    func testViaTransitousClientRequestsAllSectionsAndDwell() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder) { request in
            guard queryValue("directModes", in: request) == "BIKE" else { return TransitousFixtures.empty }
            let a = queryValue("fromPlace", in: request)!.split(separator: ",").map { Double($0)! }
            let b = queryValue("toPlace", in: request)!.split(separator: ",").map { Double($0)! }
            let time = ISO8601DateFormatter().date(from: queryValue("time", in: request)!)!
            let start = queryValue("arriveBy", in: request) == "true" ? time.addingTimeInterval(-1200) : time
            let end = start.addingTimeInterval(1200)
            let polyline: [String: Any] = ["points": TransitousFixtures.encode([(a[0],a[1]),(b[0],b[1])]), "precision": 5]
            let format = ISO8601DateFormatter()
            let leg: [String: Any] = ["mode": "BIKE", "from": ["name":"START", "lat":a[0], "lon":a[1]], "to": ["name":"END", "lat":b[0], "lon":b[1]],
                "startTime":format.string(from:start), "endTime":format.string(from:end), "distance":5000, "legGeometry":polyline,
                "steps":[["relativeDirection":"DEPART", "streetName":"Weg", "distance":5000, "polyline":polyline]]]
            return try JSONSerialization.data(withJSONObject: ["direct":[["id":"\(a)|\(b)|\(start)", "startTime":format.string(from:start), "endTime":format.string(from:end), "duration":1200, "transfers":0, "legs":[leg]]]])
        }
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let stop = RouteStop(place: viaPlace(1), stayMinutes: 10)
        for backward in [false,true] {
            let time = date("2026-09-12T10:00:00Z")
            let result = try await client.plan(RouteRequest(origin: viaPlace(0), destination: viaPlace(2), timing: backward ? .arriveBy(time) : .departAt(time), stops: [stop]), settings: settings)
            XCTAssertEqual(result.stops, [stop])
            XCTAssertEqual(result.duration, 3000)
            XCTAssertEqual(backward ? result.arrival : result.departure, time)
        }
        XCTAssertEqual(recorder.requests.count, 20)
    }

    @MainActor private func viaMissedConnectionJourney(now: Date) throws -> Journey {
        let first = viaRide(RouteRequest(origin: viaPlace(0), destination: viaPlace(1), timing: .departAt(now.addingTimeInterval(-2100))))
        let stop = RouteStop(place: viaPlace(1), stayMinutes: 10)
        let boarding = first.arrival.addingTimeInterval(600), arrival = boarding.addingTimeInterval(1200)
        let transit = TransitLeg(id: UUID(), from: stop.place, to: viaPlace(2), startTime: boarding, endTime: arrival, mode: "SUBURBAN", line: "S1", headsign: "Ziel", agency: "Test", departurePlatform: nil, arrivalPlatform: nil, isRealtime: true, isCancelled: false, coordinates: [stop.place.coordinate,viaPlace(2).coordinate], lastUpdatedAt: now)
        let second = Journey(id:"train",origin:stop.place,destination:transit.to,departure:boarding,arrival:arrival,legs:[.transit(transit)],transfers:0,isDirect:false,score:0)
        let combined = try XCTUnwrap(ViaJourneyComposer.join(first, second, at: stop))
        let final = viaRide(RouteRequest(origin: transit.to, destination: viaPlace(3), timing: .departAt(arrival)))
        return try XCTUnwrap(ViaJourneyComposer.join(combined, final, at: RouteStop(place: transit.to)))
    }

    @MainActor func testViaLateContinuationReplansOnlyUnvisitedStops() async throws {
        let now = Date(), store = try makeHomeStore(), planner = ViaRecordingPlanner()
        let original = try viaMissedConnectionJourney(now: now)
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: original, progress: NavigationProgress(legIndex: 1, maneuverIndex: 0)))
        let location = LocationService()
        let model = try AppModel(planner: planner, store: store, location: location, guidance: GuidanceService())
        XCTAssertEqual(model.routeStops, original.stops)
        location.locationManager(CLLocationManager(), didUpdateLocations: [CLLocation(coordinate: viaPlace(1).coordinate.clCoordinate, altitude:0,horizontalAccuracy:5,verticalAccuracy:5,timestamp:Date())])
        await model.continueFromStop()
        let requests = await planner.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.stops, Array(original.stops.dropFirst()))
        XCTAssertEqual(model.navigation?.journey.stops, Array(original.stops.dropFirst()))
        XCTAssertEqual(try store.loadActiveSnapshot()?.journey.stops, Array(original.stops.dropFirst()))
        model.stopNavigation()
    }

    @MainActor func testViaFailedContinuationKeepsStopAndSnapshot() async throws {
        let store = try makeHomeStore(), original = try viaMissedConnectionJourney(now: Date())
        try store.saveActiveSnapshot(ActiveJourneySnapshot(journey: original, progress: NavigationProgress(legIndex: 1, maneuverIndex: 0)))
        let location = LocationService()
        let model = try AppModel(planner: UnusedJourneyPlanner(), store: store, location: location, guidance: GuidanceService())
        location.locationManager(CLLocationManager(), didUpdateLocations: [CLLocation(coordinate: viaPlace(1).coordinate.clCoordinate, altitude:0,horizontalAccuracy:5,verticalAccuracy:5,timestamp:Date())])
        await model.continueFromStop()
        XCTAssertEqual(model.navigation?.currentLeg?.kind, .stop)
        XCTAssertEqual(model.navigation?.journey.stops, original.stops)
        XCTAssertEqual(try store.loadActiveSnapshot()?.progress?.legIndex, 1)
        model.stopNavigation()
    }
}
