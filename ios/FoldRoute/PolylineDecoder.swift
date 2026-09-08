import Foundation
import OSLog

enum PolylineDecodingError: Error, Equatable {
    case malformed
}

enum PolylineDecoder {
    static func decode(_ encoded: String, precision: Int) throws -> [Coordinate] {
        guard (0...8).contains(precision) else { throw PolylineDecodingError.malformed }
        let bytes = Array(encoded.utf8)
        let factor = pow(10.0, Double(precision))
        var index = 0
        var latitude = 0
        var longitude = 0
        var coordinates: [Coordinate] = []

        while index < bytes.count {
            let nextLatitude = latitude.addingReportingOverflow(try decodeValue(bytes, index: &index))
            let nextLongitude = longitude.addingReportingOverflow(try decodeValue(bytes, index: &index))
            guard !nextLatitude.overflow, !nextLongitude.overflow else { throw PolylineDecodingError.malformed }
            latitude = nextLatitude.partialValue
            longitude = nextLongitude.partialValue
            coordinates.append(
                Coordinate(
                    latitude: Double(latitude) / factor,
                    longitude: Double(longitude) / factor
                )
            )
        }

        return coordinates
    }

    private static func decodeValue(_ bytes: [UInt8], index: inout Int) throws -> Int {
        var result = 0
        var shift = 0
        var byte: Int

        repeat {
            guard index < bytes.count else { throw PolylineDecodingError.malformed }
            byte = Int(bytes[index]) - 63
            guard byte >= 0, shift < Int.bitWidth - 5 else { throw PolylineDecodingError.malformed }
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
        } while byte >= 0x20

        return (result & 1) == 1 ? ~(result >> 1) : result >> 1
    }
}


/// Street geometry and turn instructions must describe a continuous trip between the leg endpoints.
/// Long individual edges are allowed: sparse geometry is not evidence of a broken route.
enum StreetGeometryValidator {
    static let tolerance = 100.0
    static let transitEndpointTolerance = 500.0
    private static let logger = Logger(subsystem: "FoldRoute", category: "StreetGeometry")

    private static func rejected(_ reason: String) -> RoutePlannerError {
        logger.notice("Geometry rejected: \(reason, privacy: .public)")
        return .invalidRouteGeometry
    }

    private static func endpointMatches(_ point: Coordinate, endpoint: Coordinate, stopID: String?, side: String) -> Bool {
        let isStop = stopID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        let limit = isStop ? transitEndpointTolerance : tolerance
        let distance = point.distance(to: endpoint)
        if distance > tolerance {
            // No names, stop IDs, request URLs or coordinates in diagnostic logs.
            logger.notice("Endpoint \(side, privacy: .public): distance=\(distance)m limit=\(limit)m accepted=\(distance <= limit) station=\(isStop)")
        }
        return distance <= limit
    }

    struct Step {
        let direction: ManeuverDirection
        let distance: Double
        let streetName: String
        var coordinates: [Coordinate]
    }

    static let elevatorTolerance = 25.0

    /// A vertical, zero-distance elevator may have no polyline. Anchor the entire empty
    /// group between its actual neighbors, never filling a horizontal gap with invented geometry.
    static func normalizedSteps(
        _ steps: [Step], geometry: [Coordinate], from: Coordinate, to: Coordinate
    ) throws -> [Step] {
        guard validCoordinate(from), validCoordinate(to), geometry.allSatisfy(validCoordinate),
              steps.allSatisfy({ $0.distance.isFinite && $0.distance >= 0
                  && $0.coordinates.allSatisfy(validCoordinate) }) else {
            throw rejected("invalid or missing street geometry")
        }
        var result = steps
        var index = 0
        while index < steps.count {
            guard steps[index].coordinates.isEmpty else { index += 1; continue }
            let start = index
            while index < steps.count && steps[index].coordinates.isEmpty {
                guard steps[index].direction == .elevator, steps[index].distance == 0 else {
                    throw rejected("invalid or missing street geometry")
                }
                index += 1
            }
            let before = start > 0 ? steps[start - 1].coordinates.last! : (geometry.first ?? from)
            let after = index < steps.count ? steps[index].coordinates.first! : (geometry.last ?? to)
            let gap = before.distance(to: after)
            guard gap <= elevatorTolerance else {
                logger.notice("Elevator gap rejected: distance=\(gap)m limit=\(elevatorTolerance)m")
                throw rejected("disconnected elevator")
            }
            for position in start..<index { result[position].coordinates = [before] }
        }
        return result
    }

    static func validCoordinate(_ point: Coordinate) -> Bool {
        point.latitude.isFinite && point.longitude.isFinite
            && (-90...90).contains(point.latitude) && (-180...180).contains(point.longitude)
    }

    static func connects(_ points: [Coordinate], from: Coordinate, to: Coordinate,
                         fromTransitStopID: String? = nil, toTransitStopID: String? = nil) -> Bool {
        guard validCoordinate(from), validCoordinate(to), !points.isEmpty,
              points.allSatisfy(validCoordinate), let first = points.first, let last = points.last else { return false }
        let startMatches = endpointMatches(first, endpoint: from, stopID: fromTransitStopID, side: "start")
        let endMatches = endpointMatches(last, endpoint: to, stopID: toTransitStopID, side: "end")
        return startMatches && endMatches
    }

    static func validated(
        coordinates: [Coordinate], steps: [[Coordinate]], from: Coordinate, to: Coordinate,
        isWalk: Bool, distance: Double,
        fromTransitStopID: String? = nil, toTransitStopID: String? = nil
    ) throws -> [Coordinate] {
        guard validCoordinate(from), validCoordinate(to), distance.isFinite, distance >= 0 else {
            throw rejected("invalid or missing street geometry")
        }
        if !steps.isEmpty {
            guard steps.allSatisfy({ !$0.isEmpty && $0.allSatisfy(validCoordinate) }),
                  connects([steps[0][0], steps[steps.count - 1].last!], from: from, to: to,
                           fromTransitStopID: fromTransitStopID, toTransitStopID: toTransitStopID) else {
                throw rejected("invalid step coordinates or endpoints")
            }
            for (before, after) in zip(steps, steps.dropFirst()) {
                let gap = before.last!.distance(to: after.first!)
                guard gap <= tolerance else {
                    logger.notice("Step gap rejected: distance=\(gap)m limit=\(tolerance)m")
                    throw rejected("disconnected steps")
                }
            }
        }
        let result: [Coordinate]
        if !coordinates.isEmpty {
            result = coordinates
        } else if !steps.isEmpty {
            result = steps.flatMap { $0 }
        } else if isWalk && distance <= tolerance && from.distance(to: to) <= tolerance {
            result = [from, to]
        } else {
            throw rejected("invalid or missing street geometry")
        }
        guard connects(result, from: from, to: to,
                       fromTransitStopID: fromTransitStopID, toTransitStopID: toTransitStopID),
              result.count >= 2 || from.distance(to: to) <= tolerance else {
            throw rejected("invalid or missing street geometry")
        }
        return result
    }

    static func validate(_ journey: Journey, startingAt index: Int = 0) throws {
        for leg in journey.legs.dropFirst(index) {
            let movement: MovementLeg
            switch leg {
            case .bike(let value), .walk(let value), .approach(let value): movement = value
            default: continue
            }
            _ = try validated(coordinates: movement.coordinates, steps: movement.maneuvers.map(\.coordinates),
                              from: movement.from.coordinate, to: movement.to.coordinate,
                              isWalk: leg.kind == .walk, distance: movement.distance,
                              fromTransitStopID: movement.from.transitStopID, toTransitStopID: movement.to.transitStopID)
        }
    }
}
