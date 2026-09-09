import Foundation
import SwiftData

@Model
final class StoredPlace {
    @Attribute(.unique) var id: UUID
    var name: String
    var detail: String
    var latitude: Double
    var longitude: Double
    var isFavorite: Bool
    var lastUsedAt: Date?
    var lastUsedAsDestinationAt: Date?

    init(place: Place, isFavorite: Bool = false, lastUsedAt: Date? = Date()) {
        id = place.id
        name = place.name
        detail = place.detail
        latitude = place.coordinate.latitude
        longitude = place.coordinate.longitude
        self.isFavorite = isFavorite
        self.lastUsedAt = lastUsedAt
    }

    func matches(_ place: Place) -> Bool {
        id == place.id || (name.localizedCaseInsensitiveCompare(place.name) == .orderedSame
            && Coordinate(latitude: latitude, longitude: longitude).distance(to: place.coordinate) <= 25)
    }

    var place: Place {
        Place(
            id: id,
            name: name,
            detail: detail,
            coordinate: Coordinate(latitude: latitude, longitude: longitude)
        )
    }
}

@Model
final class StoredJourney {
    @Attribute(.unique) var id: String
    var originName: String
    var originDetail: String?
    var originLatitude: Double?
    var originLongitude: Double?
    var destinationName: String
    var destinationDetail: String?
    var destinationLatitude: Double?
    var destinationLongitude: Double?
    var departure: Date
    var arrival: Date
    var duration: Double
    var modes: String
    var completedAt: Date
    var stopsData: Data?

    init(journey: Journey, completedAt: Date = Date()) throws {
        stopsData = try JSONEncoder().encode(journey.stops)
        id = journey.id
        originName = Self.historyName(for: journey.origin)
        originDetail = journey.origin.detail
        originLatitude = journey.origin.coordinate.latitude
        originLongitude = journey.origin.coordinate.longitude
        destinationName = Self.historyName(for: journey.destination)
        destinationDetail = journey.destination.detail
        destinationLatitude = journey.destination.coordinate.latitude
        destinationLongitude = journey.destination.coordinate.longitude
        departure = journey.departure
        arrival = journey.arrival
        duration = journey.duration
        modes = journey.legs.map(\.kind.rawValue).joined(separator: ",")
        self.completedAt = completedAt
    }

    func decodedStops() throws -> [RouteStop] {
        guard let stopsData else { return [] }
        let stops = try JSONDecoder().decode([RouteStop].self, from: stopsData)
        try RouteStop.validate(stops)
        return stops
    }

    private static func historyName(for place: Place) -> String {
        place.name == "Aktueller Standort" ? "Startpunkt" : place.name
    }

    var originPlace: Place? {
        makePlace(
            name: originName,
            detail: originDetail,
            latitude: originLatitude,
            longitude: originLongitude
        )
    }

    var destinationPlace: Place? {
        makePlace(
            name: destinationName,
            detail: destinationDetail,
            latitude: destinationLatitude,
            longitude: destinationLongitude
        )
    }

    var isReplannable: Bool {
        originPlace != nil && destinationPlace != nil
    }

    private func makePlace(
        name: String,
        detail: String?,
        latitude: Double?,
        longitude: Double?
    ) -> Place? {
        guard let latitude,
              let longitude,
              latitude.isFinite,
              longitude.isFinite,
              (-90.0...90.0).contains(latitude),
              (-180.0...180.0).contains(longitude) else { return nil }
        return Place(
            name: name,
            detail: detail ?? "",
            coordinate: Coordinate(latitude: latitude, longitude: longitude)
        )
    }
}

@Model
final class StoredSettings {
    @Attribute(.unique) var key: String
    var foldDuration: Double
    var unfoldDuration: Double
    var cyclingSpeedKilometersPerHour: Double?
    var audioEnabled: Bool
    var hapticsEnabled: Bool
    var excludedTransitModeIDs: String?
    var maxCyclingMinutes: Int?
    var maxWalkingMinutes: Int?
    var maxBikeTransfers: Int?
    var showCyclingComparison: Bool?

    init(key: String = "default", settings: NavigationSettings = .defaults) {
        self.key = key
        foldDuration = settings.foldDuration
        unfoldDuration = settings.unfoldDuration
        cyclingSpeedKilometersPerHour = settings.cyclingSpeedKilometersPerHour
        audioEnabled = settings.audioEnabled
        hapticsEnabled = settings.hapticsEnabled
        excludedTransitModeIDs = Self.encode(settings.excludedTransitModes)
        maxCyclingMinutes = settings.maxCyclingMinutes
        maxWalkingMinutes = settings.maxWalkingMinutes
        maxBikeTransfers = settings.maxBikeTransfers
        showCyclingComparison = settings.showCyclingComparison
    }

    var value: NavigationSettings {
        NavigationSettings(
            foldingDuration: NavigationSettings.migratedFoldingDuration([foldDuration, unfoldDuration]),
            cyclingSpeedKilometersPerHour: cyclingSpeedKilometersPerHour
                ?? NavigationSettings.defaults.cyclingSpeedKilometersPerHour,
            audioEnabled: audioEnabled,
            hapticsEnabled: hapticsEnabled,
            excludedTransitModes: Self.decode(excludedTransitModeIDs),
            maxCyclingMinutes: min(60, max(1, maxCyclingMinutes ?? 30)),
            maxWalkingMinutes: min(15, max(1, maxWalkingMinutes ?? 2)),
            maxBikeTransfers: min(3, max(0, maxBikeTransfers ?? 2)),
            showCyclingComparison: showCyclingComparison ?? true
        )
    }

    func update(_ settings: NavigationSettings) {
        maxCyclingMinutes = settings.maxCyclingMinutes
        maxWalkingMinutes = settings.maxWalkingMinutes
        maxBikeTransfers = settings.maxBikeTransfers
        showCyclingComparison = settings.showCyclingComparison
        foldDuration = settings.foldDuration
        unfoldDuration = settings.unfoldDuration
        cyclingSpeedKilometersPerHour = settings.cyclingSpeedKilometersPerHour
        audioEnabled = settings.audioEnabled
        hapticsEnabled = settings.hapticsEnabled
        excludedTransitModeIDs = Self.encode(settings.excludedTransitModes)
    }

    private static func encode(_ modes: Set<TransitModePreference>) -> String {
        modes.map(\.rawValue).sorted().joined(separator: ",")
    }

    private static func decode(_ value: String?) -> Set<TransitModePreference> {
        guard let value else { return [] }
        return Set(value.split(separator: ",").compactMap {
            TransitModePreference(rawValue: String($0))
        })
    }
}

struct NavigationProgress: Codable, Equatable {
    var legIndex: Int
    var maneuverIndex: Int

    func isValid(for journey: Journey) -> Bool {
        guard journey.legs.indices.contains(legIndex), maneuverIndex >= 0 else { return false }
        switch journey.legs[legIndex] {
        case .approach(let leg), .bike(let leg), .walk(let leg):
            return leg.maneuvers.isEmpty ? maneuverIndex == 0 : leg.maneuvers.indices.contains(maneuverIndex)
        default:
            return maneuverIndex == 0
        }
    }
}

struct ActiveJourneySnapshot: Codable {
    let journey: Journey
    let progress: NavigationProgress?

    init(journey: Journey, progress: NavigationProgress? = nil) {
        self.journey = journey
        self.progress = progress
    }

    private enum CodingKeys: String, CodingKey { case journey, progress }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.journey) {
            journey = try container.decode(Journey.self, forKey: .journey)
            progress = try container.decodeIfPresent(NavigationProgress.self, forKey: .progress)
        } else {
            // Older app versions stored only the journey, without a started state.
            journey = try Journey(from: decoder)
            progress = nil
        }
        try RouteStop.validate(journey.stops)
        guard journey.legs.allSatisfy({ leg in
            guard case .stop(let stop) = leg else { return true }
            guard let definition = stop.stop else { return false }
            return stop.place.coordinate == definition.place.coordinate
                && stop.endTime.timeIntervalSince(stop.startTime) >= Double(definition.stayMinutes*60)
        }) else { throw RoutePlannerError.stopInput }
    }
}

@Model
final class StoredActiveJourney {
    @Attribute(.unique) var key: String
    var data: Data
    var savedAt: Date

    init(key: String = "active", snapshot: ActiveJourneySnapshot) throws {
        self.key = key
        data = try JSONEncoder().encode(snapshot)
        savedAt = Date()
    }

    func decodedSnapshot() throws -> ActiveJourneySnapshot {
        try JSONDecoder().decode(ActiveJourneySnapshot.self, from: data)
    }

    func update(_ snapshot: ActiveJourneySnapshot) throws {
        data = try JSONEncoder().encode(snapshot)
        savedAt = Date()
    }
}

@MainActor
protocol JourneyStore: AnyObject {
    func loadSettings() throws -> NavigationSettings
    func saveSettings(_ settings: NavigationSettings) throws
    func saveRecentPlace(_ place: Place, asDestination: Bool) throws
    func setFavorite(_ place: Place, isFavorite: Bool) throws
    func record(_ journey: Journey) throws
    func deleteJourney(id: String) throws
    func updateJourneyNames(
        id: String,
        originName: String?,
        destinationName: String?
    ) throws
    func loadActiveSnapshot() throws -> ActiveJourneySnapshot?
    func saveActiveSnapshot(_ snapshot: ActiveJourneySnapshot) throws
    func clearActiveJourney() throws
    func clearAll() throws
}

extension JourneyStore {
    func loadActiveJourney() throws -> Journey? {
        try loadActiveSnapshot()?.journey
    }

    func saveActiveJourney(_ journey: Journey) throws {
        try saveActiveSnapshot(ActiveJourneySnapshot(journey: journey))
    }
}

@MainActor
final class SwiftDataJourneyStore: JourneyStore {
    let container: ModelContainer
    private var context: ModelContext { container.mainContext }

    init(container: ModelContainer) {
        self.container = container
    }

    func loadSettings() throws -> NavigationSettings {
        var descriptor = FetchDescriptor<StoredSettings>()
        descriptor.fetchLimit = 1
        if let stored = try context.fetch(descriptor).first {
            return stored.value
        }

        let stored = StoredSettings()
        context.insert(stored)
        try context.save()
        return stored.value
    }

    func saveSettings(_ settings: NavigationSettings) throws {
        var descriptor = FetchDescriptor<StoredSettings>()
        descriptor.fetchLimit = 1
        if let stored = try context.fetch(descriptor).first {
            stored.update(settings)
        } else {
            context.insert(StoredSettings(settings: settings))
        }
        try context.save()
    }

    func saveRecentPlace(_ place: Place, asDestination: Bool) throws {
        let places = try context.fetch(FetchDescriptor<StoredPlace>())
        let matchingPlace = places.first { $0.id == place.id } ?? places.first { $0.matches(place) }

        let now = Date()
        if let stored = matchingPlace {
            stored.name = place.name
            stored.detail = place.detail
            stored.latitude = place.coordinate.latitude
            stored.longitude = place.coordinate.longitude
            stored.lastUsedAt = now
            if asDestination { stored.lastUsedAsDestinationAt = now }
        } else {
            let stored = StoredPlace(place: place, lastUsedAt: now)
            if asDestination { stored.lastUsedAsDestinationAt = now }
            context.insert(stored)
        }

        try trimRecentPlaces()
        try context.save()
    }

    func setFavorite(_ place: Place, isFavorite: Bool) throws {
        guard place.name != "Aktueller Standort" else { return }
        let places = try context.fetch(FetchDescriptor<StoredPlace>())
        let matchingPlace = places.first { $0.id == place.id } ?? places.first { $0.matches(place) }
        do {
            if let stored = matchingPlace {
                stored.isFavorite = isFavorite
                if !isFavorite && stored.lastUsedAt == nil { context.delete(stored) }
            } else if isFavorite {
                context.insert(StoredPlace(place: place, isFavorite: true, lastUsedAt: nil))
            }
            try trimRecentPlaces()
            try context.save()
        } catch {
            context.rollback()
            throw error
        }
    }

    private func trimRecentPlaces() throws {
        let descriptor = FetchDescriptor<StoredPlace>(
            predicate: #Predicate { !$0.isFavorite },
            sortBy: [SortDescriptor(\.lastUsedAt, order: .reverse)]
        )
        for oldPlace in try context.fetch(descriptor).dropFirst(20) {
            context.delete(oldPlace)
        }
    }

    func record(_ journey: Journey) throws {
        let journeyID = journey.id
        let descriptor = FetchDescriptor<StoredJourney>(
            predicate: #Predicate { $0.id == journeyID }
        )
        if try context.fetch(descriptor).isEmpty {
            context.insert(try StoredJourney(journey: journey))
        }

        var allDescriptor = FetchDescriptor<StoredJourney>(
            sortBy: [SortDescriptor(\.completedAt, order: .reverse)]
        )
        allDescriptor.fetchLimit = 100
        let journeys = try context.fetch(allDescriptor)
        for oldJourney in journeys.dropFirst(20) {
            context.delete(oldJourney)
        }
        try context.save()
    }

    func deleteJourney(id: String) throws {
        let descriptor = FetchDescriptor<StoredJourney>(
            predicate: #Predicate { $0.id == id }
        )
        for journey in try context.fetch(descriptor) {
            context.delete(journey)
        }
        try context.save()
    }

    func updateJourneyNames(
        id: String,
        originName: String?,
        destinationName: String?
    ) throws {
        let journeyID = id
        let descriptor = FetchDescriptor<StoredJourney>(
            predicate: #Predicate { $0.id == journeyID }
        )
        guard let journey = try context.fetch(descriptor).first else { return }
        if let originName { journey.originName = originName }
        if let destinationName { journey.destinationName = destinationName }
        try context.save()
    }

    func loadActiveSnapshot() throws -> ActiveJourneySnapshot? {
        var descriptor = FetchDescriptor<StoredActiveJourney>()
        descriptor.fetchLimit = 1
        guard let stored = try context.fetch(descriptor).first else { return nil }
        return try stored.decodedSnapshot()
    }

    func saveActiveSnapshot(_ snapshot: ActiveJourneySnapshot) throws {
        var descriptor = FetchDescriptor<StoredActiveJourney>()
        descriptor.fetchLimit = 1
        if let stored = try context.fetch(descriptor).first {
            try stored.update(snapshot)
        } else {
            context.insert(try StoredActiveJourney(snapshot: snapshot))
        }
        try context.save()
    }

    func clearActiveJourney() throws {
        try context.delete(model: StoredActiveJourney.self)
        try context.save()
    }

    func clearAll() throws {
        try context.delete(model: StoredPlace.self)
        try context.delete(model: StoredJourney.self)
        try context.delete(model: StoredSettings.self)
        try context.delete(model: StoredActiveJourney.self)
        try context.save()
    }
}
