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
            "direct": try JSONSerialization.jsonObject(with: TransitousFixtures.directBike), "expected": snapshots, "expectedTransit": transitSnapshots, "scenarios": scenarios, "viaScenarios": viaScenarios]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
    }
}
