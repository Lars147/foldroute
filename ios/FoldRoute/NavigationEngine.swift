import CoreLocation
import Foundation
import Observation

@MainActor
@Observable
final class NavigationEngine {
    private(set) var journey: Journey
    private let guidance: GuidanceService

    private(set) var phase: NavigationPhase = .idle
    private(set) var currentLegIndex = 0
    private(set) var currentManeuverIndex = 0
    private(set) var distanceToNext: CLLocationDistance?
    private(set) var isReplanning = false
    private(set) var statusMessage: String?

    var settings: NavigationSettings
    var onReroute: (() -> Void)?
    var onArrival: (() -> Void)?
    var onProgress: ((NavigationProgress) -> Void)?

    private var offRouteSamples = 0
    private var announcedManeuverIDs: Set<UUID> = []
    private var announcedTransitExitIDs: Set<UUID> = []
    private var announcedChanges: Set<String> = []

    init(journey: Journey, settings: NavigationSettings, guidance: GuidanceService) {
        self.journey = journey
        self.settings = settings
        self.guidance = guidance
    }

    var currentLeg: JourneyLeg? {
        guard journey.legs.indices.contains(currentLegIndex) else { return nil }
        return journey.legs[currentLegIndex]
    }

    var currentManeuver: Maneuver? {
        guard let currentLeg else { return nil }
        let maneuvers: [Maneuver]
        switch currentLeg {
        case .approach(let leg), .bike(let leg), .walk(let leg): maneuvers = leg.maneuvers
        default: return nil
        }
        guard maneuvers.indices.contains(currentManeuverIndex) else { return nil }
        return maneuvers[currentManeuverIndex]
    }

    var instruction: String {
        guard let currentLeg else { return "Route beendet" }
        switch currentLeg {
        case .approach(let leg):
            return currentManeuver?.instruction ?? "Zum Start bei \(leg.to.name)"
        case .bike(let leg):
            return currentManeuver?.instruction ?? "Mit dem Rad nach \(leg.to.name)"
        case .walk(let leg):
            return currentManeuver?.instruction ?? "Zu Fuß nach \(leg.to.name)"
        case .fold: return "Rad jetzt falten"
        case .unfold: return "Rad jetzt entfalten"
        case .wait: return "Auf Weiterfahrt warten"
        case .transit(let leg): return "\(leg.line) Richtung \(leg.headsign)"
        }
    }

    var detail: String {
        guard let currentLeg else { return "" }
        switch currentLeg {
        case .transit(let leg):
            let platform = leg.departurePlatform.map { "Gleis \($0)" } ?? "Gleis noch offen"
            return "\(platform) · Ausstieg \(leg.to.name)"
        case .fold(let leg), .unfold(let leg), .wait(let leg):
            return leg.place.name
        case .approach(let leg), .bike(let leg), .walk(let leg):
            return leg.to.name
        }
    }

    func start(progress: NavigationProgress = NavigationProgress(legIndex: 0, maneuverIndex: 0)) {
        guard phase == .idle else { return }
        precondition(progress.isValid(for: journey))
        currentLegIndex = progress.legIndex
        currentManeuverIndex = progress.maneuverIndex
        phase = .active(legIndex: currentLegIndex, maneuverIndex: currentManeuverIndex)
        announceCurrentPhase()
    }

    private func saveProgress() {
        onProgress?(NavigationProgress(legIndex: currentLegIndex, maneuverIndex: currentManeuverIndex))
    }

    func update(location: CLLocation) {
        guard case .active = phase, let currentLeg else { return }
        let coordinate = Coordinate(location.coordinate)

        switch currentLeg {
        case .approach(let leg), .bike(let leg), .walk(let leg):
            updateMovement(leg, location: location, coordinate: coordinate)
        case .fold(let leg), .unfold(let leg), .wait(let leg):
            distanceToNext = coordinate.distance(to: leg.place.coordinate)
        case .transit(let leg):
            distanceToNext = coordinate.distance(to: leg.to.coordinate)
        }
    }

    func tick(now: Date = Date()) {
        guard case .active = phase, let currentLeg else { return }
        switch currentLeg {
        case .fold, .wait:
            if let next = journey.remainingTransit(from: currentLegIndex).first,
               !TransitRefreshPolicy.canUseTimes(next, now: now) { return }
            if now >= currentLeg.endTime { advanceAutomatically(now: now) }
        case .unfold:
            if now >= currentLeg.endTime { advanceAutomatically(now: now) }
        case .transit(let leg):
            guard TransitRefreshPolicy.canUseTimes(leg, now: now) else { return }
            if leg.endTime.timeIntervalSince(now) <= 300,
               leg.endTime > now,
               !announcedTransitExitIDs.contains(leg.id) {
                announcedTransitExitIDs.insert(leg.id)
                guidance.speak("In fünf Minuten bei \(leg.to.name) aussteigen", settings: settings)
                guidance.signal(.warning, settings: settings)
            }
            if now >= leg.endTime { advanceAutomatically(now: now) }
        case .approach, .bike, .walk:
            break
        }
    }

    private func advanceAutomatically(now: Date) {
        let next = currentLegIndex + 1
        if journey.legs.indices.contains(next), case .transit(let leg) = journey.legs[next],
           !TransitRefreshPolicy.canUseTimes(leg, now: now) { return }
        advance()
    }

    func advance() {
        guard phase != .arrived else { return }
        let nextIndex = currentLegIndex + 1
        guard journey.legs.indices.contains(nextIndex) else {
            phase = .arrived
            guidance.speak("Ziel erreicht", settings: settings)
            guidance.signal(.success, settings: settings)
            onArrival?()
            return
        }

        currentLegIndex = nextIndex
        currentManeuverIndex = 0
        distanceToNext = nil
        offRouteSamples = 0
        phase = .active(legIndex: currentLegIndex, maneuverIndex: 0)
        saveProgress()
        announceCurrentPhase()
    }

    func applyTransitJourney(_ updated: Journey) {
        precondition(updated.legs.map(\.id) == journey.legs.map(\.id))
        for (index, pair) in zip(journey.legs, updated.legs).enumerated() where index >= currentLegIndex {
            guard case .transit(let old) = pair.0, case .transit(let new) = pair.1 else { continue }
            if index > currentLegIndex, let platform = new.departurePlatform,
               platform != old.departurePlatform, new.refreshFailure == nil {
                announceChange("platform-\(new.id)-\(platform)", message: "\(new.line) fährt jetzt von Gleis \(platform).")
            }
        }
        journey = updated
    }

    func announceChange(_ key: String, message: String) {
        guard announcedChanges.insert(key).inserted else { return }
        guidance.speak(message, settings: settings)
        guidance.signal(.warning, settings: settings)
    }

    func setReplanning(_ value: Bool, message: String? = nil) {
        isReplanning = value
        statusMessage = message
    }

    private func updateMovement(_ leg: MovementLeg, location: CLLocation, coordinate: Coordinate) {
        let distanceFromRoute = leg.coordinates.map { coordinate.distance(to: $0) }.min() ?? 0
        if location.horizontalAccuracy <= 50, distanceFromRoute > 60 {
            offRouteSamples += 1
        } else {
            offRouteSamples = 0
        }

        if offRouteSamples >= 3, !isReplanning {
            offRouteSamples = 0
            isReplanning = true
            statusMessage = "Route wird angepasst …"
            onReroute?()
        }

        if let maneuver = currentManeuver, let endpoint = maneuver.endpoint {
            let distance = coordinate.distance(to: endpoint)
            distanceToNext = distance
            if distance <= 100, !announcedManeuverIDs.contains(maneuver.id) {
                announcedManeuverIDs.insert(maneuver.id)
                guidance.speak(maneuver.instruction, settings: settings)
                guidance.signal(.warning, settings: settings)
            }
            if distance <= 25 {
                advanceManeuver(in: leg)
            }
        } else {
            distanceToNext = coordinate.distance(to: leg.to.coordinate)
        }

        if coordinate.distance(to: leg.to.coordinate) <= 40 {
            advanceAutomatically(now: location.timestamp)
        }
    }

    private func advanceManeuver(in leg: MovementLeg) {
        let next = currentManeuverIndex + 1
        guard leg.maneuvers.indices.contains(next) else { return }
        currentManeuverIndex = next
        phase = .active(legIndex: currentLegIndex, maneuverIndex: next)
        saveProgress()
    }

    private func announceCurrentPhase() {
        guard let currentLeg else { return }
        switch currentLeg {
        case .approach:
            guidance.speak("Fahre zuerst zum geplanten Start", settings: settings)
        case .fold:
            guidance.speak("Halte an und falte dein Rad", settings: settings)
        case .unfold:
            guidance.speak("Entfalte dein Rad für den letzten Abschnitt", settings: settings)
        case .transit(let leg):
            let platform = leg.departurePlatform.map { " von Gleis \($0)" } ?? ""
            guidance.speak("Nimm \(leg.line) Richtung \(leg.headsign)\(platform)", settings: settings)
        case .bike, .walk:
            guidance.speak(instruction, settings: settings)
        case .wait:
            guidance.speak("Warte hier auf deine Weiterfahrt", settings: settings)
        }
    }
}
