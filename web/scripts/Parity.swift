import Foundation

// Navigation state is irrelevant to routing; this supplies the type used by TransitRefresh.
struct NavigationProgress: Equatable { var legIndex: Int; var maneuverIndex: Int }
final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let direct = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.contains { $0.name == "directModes" && $0.value == "BIKE" }
        let data = direct ? (request.url!.host == "transit.test" ? TransitousFixtures.empty : TransitousFixtures.directBike) : TransitousFixtures.multimodal
        client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client!.urlProtocol(self, didLoad: data)
        client!.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class ViaParityCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Journey] = []
    func record(_ update: JourneyOptionsUpdate) { lock.withLock { values = update.journeys } }
    var journeys: [Journey] { lock.withLock { values } }
}
@main struct Export {
    static func walkingCases() async throws -> [[String: Any]] {
        let a = Place(name: "A", coordinate: Coordinate(latitude: 48.13, longitude: 11.57))
        let b = Place(name: "B", coordinate: Coordinate(latitude: 48.14, longitude: 11.57))
        let c = Place(name: "C", coordinate: Coordinate(latitude: 48.15, longitude: 11.57))
        func date(_ seconds: Double) -> Date { Date(timeIntervalSince1970: seconds) }
        func movement(_ start: Double, _ end: Double) -> MovementLeg {
            MovementLeg(from: a, to: b, startTime: date(start), endTime: date(end), distance: 1000, coordinates: [a.coordinate, b.coordinate], maneuvers: [])
        }
        func transit(_ from: Place, _ to: Place, _ start: Double, _ end: Double) -> JourneyLeg {
            .transit(TransitLeg(from: from, to: to, startTime: date(start), endTime: date(end), mode: "SUBURBAN", line: "S8", headsign: "C", agency: "Test", departurePlatform: nil, arrivalPlatform: nil, isRealtime: false, isCancelled: false, coordinates: [from.coordinate, to.coordinate]))
        }
        func journey(_ legs: [JourneyLeg]) -> Journey {
            Journey(id: "original", origin: legs[0].startPlace, destination: legs.last!.endPlace, departure: legs[0].startTime, arrival: legs.last!.endTime, legs: legs, transfers: 0, isDirect: false, score: 0)
        }
        let access = journey([.walk(movement(1000, 1300)), .fold(TransitionLeg(place: b, startTime: date(1300), endTime: date(1500))), transit(b, c, 1500, 2000)])
        let transfer = journey([transit(a, a, 0, 1000), .walk(movement(1000, 1600)), transit(b, c, 1600, 2000)])
        let cases: [(String, Journey, Double, Double, Int, Int)] = [
            ("access", access, 1000, 1100, 30, 2),
            ("early", access, 999, 1100, 30, 2),
            ("late", access, 1000, 1301, 30, 2),
            ("limit", access, 1000, 1100, 1, 2),
            ("transfer", transfer, 1060, 1360, 30, 2),
            ("buffer", transfer, 1060, 1361, 30, 2),
            ("noBikeTransfer", transfer, 1060, 1360, 30, 0),
        ]
        let snapshots = cases.map { name, original, start, end, limit, maxTransfers in
            var settings = NavigationSettings.defaults
            settings.foldingDuration = 60; settings.maxCyclingMinutes = limit; settings.maxBikeTransfers = maxTransfers
            let ride = journey([.bike(movement(start, end))])
            let result = WalkingRouteOptimizer.replacing(WalkingRouteOptimizer.blocks([original])[0], with: ride, settings: settings)
            let expected = name == "access" || name == "transfer"
            precondition((result != nil) == expected, "Walking replacement mismatch: \(name)")
            if let result {
                precondition(JourneyOptionSelector.comesBefore(result, original, timing: .leaveNow))
            }
            return ["name": name, "accepted": result != nil, "kinds": result?.legs.map { $0.kind.rawValue } ?? []]
        }
        var settings = NavigationSettings.defaults
        settings.foldingDuration = 60
        let query = RouteRequest(origin: a, destination: c, timing: .departAt(date(1000)))
        let bike = journey([.bike(movement(1000, 1100))])
        let optimized = try await WalkingRouteOptimizer.run([access], request: query, settings: settings, fetch: { _ in [bike] }, emit: { _, _ in })
        precondition(optimized.count == 2 && optimized.last!.walkingSeconds == 0)
        let empty = try await WalkingRouteOptimizer.run([access], request: query, settings: settings, fetch: { _ in throw RoutePlannerError.noRoute }, emit: { _, _ in })
        precondition(empty.count == 1 && empty[0].id == access.id)
        let budget = WaypointRequestBudget(maximum: 6, seconds: 10)
        for _ in 0..<6 { _ = try await budget.take() }
        do { _ = try await budget.take(); preconditionFailure("Request budget exceeded") }
        catch { precondition(error as? RoutePlannerError == .stopBudget) }
        return snapshots
    }

    static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        let client = TransitousClient(session: URLSession(configuration: config), planningPause: PlanningServerPause())
        let origin = Place(name: "Start", coordinate: Coordinate(latitude: 48.132, longitude: 11.5756))
        let destination = Place(name: "Ziel", coordinate: Coordinate(latitude: 48.175, longitude: 11.6))
        let date = ISO8601DateFormatter().date(from: "2026-09-04T08:00:00Z")!
        var settings = NavigationSettings.defaults
        settings.maxBikeTransfers = 0
        let request = RouteRequest(origin: origin, destination: destination, timing: .departAt(date))
        let journeys = try await client.planAlternatives(request, settings: settings)
        let snapshots: [[String: Any]] = journeys.map { j in
            ["id": j.id, "departure": j.departure.timeIntervalSince1970, "arrival": j.arrival.timeIntervalSince1970,
             "transfers": j.transfers, "isDirect": j.isDirect,
             "legs": j.legs.map { l -> [String: Any] in ["kind": l.kind.rawValue, "start": l.startTime.timeIntervalSince1970, "end": l.endTime.timeIntervalSince1970, "distance": l.distance] }]
        }
        let transitClient = TransitousClient(session: URLSession(configuration: config), baseURL: URL(string: "https://transit.test/api/v6/plan")!, planningPause: PlanningServerPause())
        let transit = try await transitClient.planAlternatives(request, settings: settings)
        let transitSnapshots: [[String: Any]] = transit.map { j in
            ["id": j.id, "departure": j.departure.timeIntervalSince1970, "arrival": j.arrival.timeIntervalSince1970,
             "transfers": j.transfers, "isDirect": j.isDirect,
             "legs": j.legs.map { l -> [String: Any] in ["kind": l.kind.rawValue, "start": l.startTime.timeIntervalSince1970, "end": l.endTime.timeIntervalSince1970, "distance": l.distance] }]
        }
        var scenarios: [[String: Any]] = []
        for duration in [60.0, 150.0, 360.0] {
            for arrival in [false, true] {
                var custom = settings
                custom.foldingDuration = duration
                let time = arrival ? date.addingTimeInterval(7200) : date
                let query = RouteRequest(origin: origin, destination: destination,
                    timing: arrival ? .arriveBy(time) : .departAt(time))
                let results = try await transitClient.planAlternatives(query, settings: custom)
                scenarios.append(["duration": duration, "timing": arrival ? "arrive" : "depart",
                    "time": time.timeIntervalSince1970, "expected": results.map { j -> [String: Any] in
                        ["id": j.id, "departure": j.departure.timeIntervalSince1970, "arrival": j.arrival.timeIntervalSince1970,
                         "transfers": j.transfers, "isDirect": j.isDirect,
                         "legs": j.legs.map { l -> [String: Any] in ["kind": l.kind.rawValue, "start": l.startTime.timeIntervalSince1970, "end": l.endTime.timeIntervalSince1970, "distance": l.distance] }]
                    }])
            }
        }
        var viaScenarios: [[String: Any]] = []
        for count in 1...3 {
            for backward in [false, true] {
                let place: (Int) -> Place = { n in Place(name: "Ort \(n)", coordinate: Coordinate(latitude: 48 + Double(n)*0.01, longitude: 11.5)) }
                let stops = (1...count).map { RouteStop(id: "stop-\($0)", place: place($0), stayMinutes: 10) }
                let request = RouteRequest(origin: place(0), destination: place(count+1), timing: backward ? .arriveBy(date) : .departAt(date), stops: stops)
                let collector = ViaParityCollector()
                try await ViaRoutePlanner.run(request, settings: settings, fetch: { request, _, _ in
                    let start = request.timing.isArrival ? request.timing.date.addingTimeInterval(-1200) : request.timing.date
                    let end = start.addingTimeInterval(1200)
                    let journey = Journey(id: "\(request.origin.name)|\(request.destination.name)", origin: request.origin, destination: request.destination, departure: start, arrival: end,
                        legs: [.bike(MovementLeg(from: request.origin, to: request.destination, startTime: start, endTime: end, distance: 5000, coordinates: [request.origin.coordinate, request.destination.coordinate], maneuvers: []))], transfers: 0, isDirect: true, score: end.timeIntervalSince1970)
                    return JourneyOptionsUpdate(journeys: [journey], status: .complete)
                }, emit: { collector.record($0) })
                viaScenarios.append(["count": count, "timing": backward ? "arrive" : "depart", "time": date.timeIntervalSince1970,
                    "expected": collector.journeys.map { j -> [String: Any] in
                        ["departure": j.departure.timeIntervalSince1970, "arrival": j.arrival.timeIntervalSince1970,
                         "transfers": j.transfers, "isDirect": j.isDirect, "excess": CyclingComparison.excess(j, limit: 30),
                         "legs": j.legs.map { ["kind": $0.kind.rawValue, "start": $0.startTime.timeIntervalSince1970, "end": $0.endTime.timeIntervalSince1970] as [String: Any] }]
                    }])
            }
        }
        let payload: [String: Any] = ["multimodal": try JSONSerialization.jsonObject(with: TransitousFixtures.multimodal),
            "direct": try JSONSerialization.jsonObject(with: TransitousFixtures.directBike), "expected": snapshots, "expectedTransit": transitSnapshots, "scenarios": scenarios, "viaScenarios": viaScenarios, "walkingCases": try await walkingCases()]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
    }
}
