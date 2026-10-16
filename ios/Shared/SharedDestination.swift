import Foundation

struct SharePayload: Codable, Equatable, Sendable {
    var title: String = ""
    var text: String = ""
    var url: String = ""
}

struct SharedDestination: Codable, Equatable, Sendable {
    var kind: String
    var latitude: Double?
    var longitude: Double?
    var name: String?
    var query: String?

    static let unsupportedMessage = "Adresse aus dem Kartenlink nicht erkannt. Bitte Ziel eingeben."
    private static let linkPattern = #"(?:https?://|[a-z][a-z0-9+.-]*://)[^\s<>]+"#

    static func parse(_ payload: SharePayload) -> Self {
        let values = [payload.url, payload.text, payload.title]
        guard !values.contains(where: { $0.utf16.count > 8192 }),
              values.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            return Self(kind: "invalid")
        }
        for value in values {
            let regex = try! NSRegularExpression(pattern: linkPattern, options: .caseInsensitive)
            for match in regex.matches(in: value, range: NSRange(value.startIndex..., in: value)) {
                guard let range = Range(match.range, in: value) else { continue }
                let result = mapTarget(String(value[range]))
                if result.kind != "unsupported" { return result }
            }
        }
        for value in [payload.text, payload.title] {
            let text = clean(value.replacingOccurrences(of: linkPattern, with: "", options: [.regularExpression, .caseInsensitive]))
            if text.count >= 2,
               text.range(of: #"^(?:apple maps|google maps|karten|maps|standort)$"#, options: [.regularExpression, .caseInsensitive]) == nil {
                return target(text)
            }
        }
        return Self(kind: "unsupported")
    }

    private static func clean(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    }

    private static func target(_ value: String, name: String? = nil) -> Self {
        let query = clean(value)
        guard !query.isEmpty else { return Self(kind: "unsupported") }
        let expression = try! NSRegularExpression(pattern: #"^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$"#)
        if let match = expression.firstMatch(in: query, range: NSRange(query.startIndex..., in: query)),
           let latRange = Range(match.range(at: 1), in: query), let lonRange = Range(match.range(at: 2), in: query),
           let latitude = Double(query[latRange]), let longitude = Double(query[lonRange]) {
            guard abs(latitude) <= 90, abs(longitude) <= 180 else { return Self(kind: "invalid") }
            return Self(kind: "place", latitude: latitude, longitude: longitude, name: name ?? "Geteiltes Ziel")
        }
        if query.range(of: #"^[\d+.,\s-]+$"#, options: .regularExpression) != nil { return Self(kind: "invalid") }
        if query.range(of: linkPattern, options: [.regularExpression, .caseInsensitive]) != nil { return Self(kind: "unsupported") }
        return Self(kind: "query", query: query)
    }

    private static func mapTarget(_ raw: String) -> Self {
        guard let url = URLComponents(string: raw), let host = url.host?.lowercased(),
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return Self(kind: "unsupported") }
        func parameter(_ key: String) -> String? {
            // Form-encoded links use '+' for spaces. Decode it before percent
            // escapes so an actual %2B remains a literal plus, as on the web.
            for pair in (url.percentEncodedQuery ?? "").split(separator: "&") {
                let fields = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                func decoded(_ field: Substring) -> String? {
                    String(field).replacingOccurrences(of: "+", with: " ").removingPercentEncoding
                }
                if decoded(fields[0]) == key { return fields.count == 2 ? decoded(fields[1]) : "" }
            }
            return nil
        }
        if host == "maps.apple.com" {
            let label = parameter("name") ?? parameter("q")
            if let destination = parameter("daddr") { return target(destination) }
            if url.path == "/directions", let destination = parameter("destination") { return target(destination) }
            if url.path == "/place", let coordinate = parameter("coordinate") { return target(coordinate, name: label) }
            if let coordinate = parameter("ll"), let label = parameter("q"), !label.isEmpty { return target(coordinate, name: label) }
            if let address = parameter("address"), !address.isEmpty { return target(address) }
            if let query = parameter("q"), !query.isEmpty { return target(query) }
        }
        if host.range(of: #"^(?:www\.|maps\.)?google\.(?:com|de|at|ch|co\.uk)$"#, options: .regularExpression) != nil,
           url.path.hasPrefix("/maps") || host.hasPrefix("maps.") {
            for key in ["destination", "query", "q", "daddr"] {
                if let query = parameter(key), !query.isEmpty { return target(query) }
            }
        }
        return Self(kind: "unsupported")
    }
}

struct PendingSharedDestination: Codable, Identifiable, Equatable, Sendable {
    var version = 1
    var id = UUID()
    var payload: SharePayload
}

enum SharedDestinationStorageError: LocalizedError {
    case unavailable, invalid
    var errorDescription: String? { "Geteiltes Ziel konnte nicht gespeichert oder geladen werden. Bitte App-Gruppen-Konfiguration prüfen." }
}

/// Only the pending import lives here; the app's SwiftData database stays private.
struct SharedDestinationStore {
    let directory: URL

    static func configured() throws -> Self {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FoldRouteAppGroup") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw SharedDestinationStorageError.unavailable
        }
        return Self(directory: directory)
    }

    private var file: URL { directory.appendingPathComponent("pending-destination.json") }

    private func coordinated<T>(_ operation: (URL) throws -> T) throws -> T {
        var coordinationError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator().coordinate(writingItemAt: file, options: .forMerging, error: &coordinationError) { url in
            result = Result { try operation(url) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw SharedDestinationStorageError.unavailable }
        return try result.get()
    }

    func read() throws -> PendingSharedDestination? {
        try coordinated { url in
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            let item = try JSONDecoder().decode(PendingSharedDestination.self, from: Data(contentsOf: url))
            guard item.version == 1 else { throw SharedDestinationStorageError.invalid }
            return item
        }
    }

    func save(_ item: PendingSharedDestination) throws {
        try coordinated { url in try JSONEncoder().encode(item).write(to: url, options: .atomic) }
    }

    func remove(id: UUID? = nil) throws {
        try coordinated { url in
            guard FileManager.default.fileExists(atPath: url.path) else { return }
            if let id {
                let current = try JSONDecoder().decode(PendingSharedDestination.self, from: Data(contentsOf: url))
                guard current.id == id else { return }
            }
            try FileManager.default.removeItem(at: url)
        }
    }
}
