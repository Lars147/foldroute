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
        let payload: [String: Any] = ["multimodal": try JSONSerialization.jsonObject(with: TransitousFixtures.multimodal),
            "direct": try JSONSerialization.jsonObject(with: TransitousFixtures.directBike), "expected": snapshots, "expectedTransit": transitSnapshots, "scenarios": scenarios]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
    }
}
