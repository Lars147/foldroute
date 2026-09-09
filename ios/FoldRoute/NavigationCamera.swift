import CoreLocation
import MapKit

struct NavigationCameraInput: Equatable {
    var location: CLLocation?
    var kind: JourneyLegKind
    var coordinates: [Coordinate]
    var fallback: Coordinate

    init(location: CLLocation?, leg: JourneyLeg?, maneuver: Maneuver?, fallback: Coordinate) {
        self.location = location
        kind = leg?.kind ?? .bike
        if let maneuver, !maneuver.coordinates.isEmpty {
            coordinates = maneuver.coordinates
        } else {
            coordinates = leg?.coordinates ?? []
        }
        self.fallback = coordinates.first ?? leg?.startPlace.coordinate ?? fallback
    }
}

struct NavigationCameraTarget: Equatable {
    var coordinate: Coordinate
    var heading: Double
    var distance: Double
}

/// Camera state is deliberately independent of persisted navigation progress.
struct NavigationCameraState {
    private(set) var isFollowing = true
    private(set) var target: NavigationCameraTarget?
    private var lastLocation: Coordinate?

    mutating func pause() { isFollowing = false }
    mutating func resume() { isFollowing = true }

    mutating func update(_ input: NavigationCameraInput, now: Date = Date()) -> NavigationCameraTarget? {
        guard isFollowing else { return nil }
        let location = input.location.flatMap { NavigationStartPolicy.isUsable($0, now: now) ? $0 : nil }
        if let location { lastLocation = Coordinate(location.coordinate) }
        let coordinate = lastLocation ?? input.fallback
        let course = location.flatMap { $0.speed >= 1 && $0.course >= 0 ? $0.course : nil }
        let bearing = course ?? target?.heading
            ?? Self.routeHeading(coordinates: input.coordinates, near: coordinate) ?? 0
        let heading = target.map { $0.heading + Self.headingDelta(from: $0.heading, to: bearing) } ?? bearing
        let distance: Double
        switch input.kind {
        case .approach, .bike: distance = 600
        case .walk: distance = 350
        case .transit: distance = 1_500
        case .fold, .unfold, .wait, .stop: distance = target?.distance ?? 600
        }
        let updated = NavigationCameraTarget(coordinate: coordinate, heading: heading, distance: distance)
        target = updated
        return updated
    }

    static func headingDelta(from: Double, to: Double) -> Double {
        let delta = (to - from).truncatingRemainder(dividingBy: 360)
        return delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta
    }

    static func anchor(viewport: CGSize, insets: MapCameraInsets) -> CGPoint {
        let top = min(max(0, insets.top), viewport.height)
        let bottom = max(top, viewport.height - max(0, insets.bottom))
        return CGPoint(x: viewport.width / 2, y: top + (bottom - top) * 2 / 3)
    }

    private static func routeHeading(coordinates: [Coordinate], near coordinate: Coordinate) -> Double? {
        let location = MKMapPoint(coordinate.clCoordinate)
        let segments = zip(coordinates, coordinates.dropFirst()).compactMap { start, end -> (Double, Double)? in
            let a = MKMapPoint(start.clCoordinate)
            let b = MKMapPoint(end.clCoordinate)
            let dx = b.x - a.x, dy = b.y - a.y
            let squaredLength = dx * dx + dy * dy
            guard squaredLength > 0 else { return nil }
            let t = min(1, max(0, ((location.x - a.x) * dx + (location.y - a.y) * dy) / squaredLength))
            let distance = hypot(location.x - a.x - t * dx, location.y - a.y - t * dy)
            let heading = (atan2(dx, -dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
            return (distance, heading)
        }
        return segments.min { $0.0 < $1.0 }?.1
    }
}
