import CoreLocation
import Observation
import SwiftData
import SwiftUI

struct PlaceSuggestion: Identifiable, Equatable, Sendable {
    let id: UUID
    let title: String
    let subtitle: String

    init(id: UUID = UUID(), title: String, subtitle: String = "") {
        self.id = id
        self.title = title
        self.subtitle = subtitle
    }

    var label: String { subtitle.isEmpty ? title : "\(title), \(subtitle)" }
}

enum PlaceSearchAction: Equatable {
    case select, favorite
}

@MainActor
protocol PlaceSearching {
    func search(_ query: String, near center: Coordinate) async throws -> [PlaceSuggestion]
    func resolve(_ suggestion: PlaceSuggestion) async throws -> [Place]
    func cancel()
}

@MainActor
@Observable
final class PlaceSearchModel {
    var query = ""
    private(set) var requestID = 0
    private(set) var results: [PlaceSuggestion] = []
    private(set) var isSearching = false
    private(set) var isResolving = false
    private(set) var resolvingID: UUID?
    private(set) var errorMessage: String?
    private(set) var resolutionError: String?
    private(set) var choices: [Place] = []
    private(set) var failedResolution: (PlaceSuggestion, PlaceSearchAction)?
    private var choiceSource: (PlaceSuggestion, PlaceSearchAction)?
    private var resolvedPlaces: [UUID: [Place]] = [:]
    private let service: any PlaceSearching
    private(set) var generation = 0
    private var isPrefilled = false

    var searchTerm: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    init(service: any PlaceSearching = PlaceSearchService()) {
        self.service = service
    }

    static func searchCenter(location: CLLocation?, now: Date = Date()) -> Coordinate {
        guard let location, CLLocationCoordinate2DIsValid(location.coordinate),
              location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 100,
              abs(location.timestamp.timeIntervalSince(now)) <= 60 else {
            return Place.munichCenter.coordinate
        }
        return Coordinate(location.coordinate)
    }

    func edit(_ text: String) {
        guard text != query else { return }
        cancel()
        query = text
        isPrefilled = false
        results = []
        resolvedPlaces = [:]
        requestID += 1
    }

    func prefill(_ title: String) {
        cancel()
        query = title.trimmingCharacters(in: .whitespacesAndNewlines) + " "
        isPrefilled = true
        // Changing the task ID cancels an old debounce without starting a new query.
        requestID += 1
    }

    func submit() {
        cancel()
        isPrefilled = false
        requestID += 1
    }

    func cancel() {
        generation += 1
        service.cancel()
        isSearching = false
        isResolving = false
        resolvingID = nil
        errorMessage = nil
        backToSuggestions()
    }

    func backToSuggestions() {
        choices = []
        choiceSource = nil
        failedResolution = nil
        resolutionError = nil
    }

    func cachedPlace(for suggestion: PlaceSuggestion) -> Place? {
        guard let places = resolvedPlaces[suggestion.id], places.count == 1 else { return nil }
        return places[0]
    }

    func search(near center: Coordinate = Place.munichCenter.coordinate) async {
        guard !isPrefilled else { return }
        generation += 1
        let currentGeneration = generation
        let term = searchTerm
        results = []
        errorMessage = nil
        isSearching = term.count >= 2
        guard isSearching else { return }
        defer {
            if currentGeneration == generation { isSearching = false }
        }
        do {
            try await Task.sleep(for: .milliseconds(280))
            let matches = try await service.search(term, near: center)
            guard !Task.isCancelled, currentGeneration == generation, term == searchTerm else { return }
            results = Array(matches.prefix(12))
        } catch is CancellationError {
            // Cancellation is expected while typing or leaving the search.
        } catch {
            guard !Task.isCancelled, currentGeneration == generation, term == searchTerm else { return }
            errorMessage = "Prüfe die Internetverbindung und versuche es erneut."
        }
    }

    func resolve(_ suggestion: PlaceSuggestion, action: PlaceSearchAction,
                 onResolved: (Place, PlaceSearchAction) -> Void) async {
        guard !isResolving else { return }
        let currentGeneration = generation
        isResolving = true
        resolvingID = suggestion.id
        backToSuggestions()
        defer {
            if currentGeneration == generation {
                isResolving = false
                resolvingID = nil
            }
        }
        do {
            let places: [Place]
            if let cached = resolvedPlaces[suggestion.id] {
                places = cached
            } else {
                places = try await service.resolve(suggestion)
            }
            guard !Task.isCancelled, currentGeneration == generation else { return }
            var unique: [Place] = []
            for place in places where !unique.contains(where: {
                $0.name.localizedCaseInsensitiveCompare(place.name) == .orderedSame
                    && $0.coordinate.distance(to: place.coordinate) <= 25
            }) { unique.append(place) }
            guard !unique.isEmpty else { throw PlaceLookupError.noPlace }
            resolvedPlaces[suggestion.id] = unique
            if unique.count == 1 {
                onResolved(unique[0], action)
            } else {
                choices = unique
                choiceSource = (suggestion, action)
            }
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled, currentGeneration == generation else { return }
            failedResolution = (suggestion, action)
            resolutionError = "Ort konnte nicht ermittelt werden. Bitte erneut versuchen."
        }
    }

    func choose(_ place: Place, onResolved: (Place, PlaceSearchAction) -> Void) {
        guard let (suggestion, action) = choiceSource, choices.contains(place) else { return }
        resolvedPlaces[suggestion.id] = [place]
        backToSuggestions()
        onResolved(place, action)
    }
}

struct PlaceSearchView: View {
    let target: SearchTarget
    let onSelect: (Place) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PlaceSearchContent(target: target) { place in
                onSelect(place)
                dismiss()
            }
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
        }
    }
}

struct PlaceSearchContent: View {
    let target: SearchTarget
    var isDisabled = false
    let onSelect: (Place) -> Void

    @Environment(AppModel.self) private var model
    @Query(sort: \StoredPlace.lastUsedAt, order: .reverse) private var recentPlaces: [StoredPlace]
    @State private var search = PlaceSearchModel()
    @State private var isLocating = false
    @State private var locationError: String?
    @State private var favoriteError: String?
    @FocusState private var isFocused: Bool
    @State private var textSelection: TextSelection?

    private var favorites: [StoredPlace] {
        recentPlaces.filter(\.isFavorite).sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.id.uuidString < $1.id.uuidString : order == .orderedAscending
        }
    }

    private var visibleRecents: [StoredPlace] {
        Array(recentPlaces.filter { !$0.isFavorite && $0.lastUsedAt != nil }.prefix(5))
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(text: Binding(get: { search.query }, set: {
                    favoriteError = nil
                    search.edit($0)
                }), selection: $textSelection) {
                    Text(target == .destination ? "Wohin?" : "Start suchen")
                }
                    .font(.title3)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { search.submit() }
                    .focused($isFocused)
                    .accessibilityIdentifier(target == .destination ? "destinationSearch" : "originSearch")
                if !search.query.isEmpty {
                    Button {
                        search.edit("")
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 32, minHeight: 32)
                    }
                    .accessibilityLabel("Suche löschen")
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 58)
            .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .tint(FoldRouteColor.routeCyan)

            if let favoriteError {
                Text(favoriteError)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .accessibilityLabel("Fehler: \(favoriteError)")
            }
            searchResults
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(Color(.systemBackground))
        .disabled(isDisabled || isLocating)
        .task(id: search.requestID) {
            await search.search(near: PlaceSearchModel.searchCenter(location: model.location.currentLocation))
        }
        .onDisappear { search.cancel() }
        .task(id: isLocating) {
            guard isLocating else { return }
            let place = await model.currentPlaceForSelection()
            guard !Task.isCancelled else { return }
            isLocating = false
            if let place {
                isFocused = false
                onSelect(place)
            } else {
                locationError = "Standort nicht verfügbar. Prüfe die Standortfreigabe in den Einstellungen und versuche es erneut."
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        if search.searchTerm.isEmpty {
            List {
                Button {
                    locationError = nil
                    isLocating = true
                } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "location.fill")
                            .foregroundStyle(FoldRouteColor.asphalt)
                            .frame(width: 34, height: 34)
                            .background(FoldRouteColor.routeCyan, in: Circle())
                        Text(isLocating ? "Standort wird ermittelt …" : "Aktueller Standort")
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Spacer()
                        if isLocating { ProgressView() }
                    }
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Aktueller Standort")
                if let locationError {
                    Text(locationError)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if !favorites.isEmpty {
                    Section("Favoriten") {
                        ForEach(favorites) { stored in
                            placeButton(stored.place, systemImage: "star.fill", color: FoldRouteColor.signalYellow)
                        }
                    }
                    .textCase(nil)
                }
                Section("Zuletzt verwendet") {
                    if visibleRecents.isEmpty {
                        Text("Suche eine Straße, Haltestelle oder einen Ort.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(visibleRecents) { stored in
                        placeButton(stored.place, systemImage: "clock.arrow.circlepath", color: FoldRouteColor.signalYellow)
                    }
                }
                .textCase(nil)
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
        } else if search.searchTerm.count < 2 {
            Text("Mindestens zwei Zeichen eingeben.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(24)
        } else {
            List {
                if !search.choices.isEmpty {
                    Section("Ort auswählen") {
                        Button("Zurück zu Vorschlägen") { search.backToSuggestions() }
                        ForEach(search.choices) { place in
                            placeButton(place, systemImage: "mappin", color: FoldRouteColor.routeCyan)
                        }
                    }
                    .textCase(nil)
                } else {
                    let matchingFavorites = favorites.filter {
                        $0.name.localizedStandardContains(search.searchTerm)
                            || $0.detail.localizedStandardContains(search.searchTerm)
                    }
                    if !matchingFavorites.isEmpty {
                        Section("Favoriten") {
                            ForEach(matchingFavorites) { stored in
                                placeButton(stored.place, systemImage: "star.fill", color: FoldRouteColor.signalYellow)
                            }
                        }
                        .textCase(nil)
                    }
                    if search.isSearching {
                        ProgressView("Vorschläge werden geladen …")
                    } else if let error = search.errorMessage {
                        Text(error).foregroundStyle(.secondary)
                        Button("Erneut suchen") { search.submit() }
                    } else {
                        if search.results.isEmpty && matchingFavorites.isEmpty {
                            Text("Keine Vorschläge. Ergänze den Ortsnamen oder die Adresse.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(search.results) { suggestion in
                            if let place = search.cachedPlace(for: suggestion) {
                                if !matchingFavorites.contains(where: { $0.matches(place) }) {
                                    placeButton(place, systemImage: "mappin", color: FoldRouteColor.routeCyan)
                                }
                            } else {
                                suggestionRow(suggestion)
                            }
                        }
                    }
                }
                if search.isResolving {
                    ProgressView("Ort wird ermittelt …")
                        .accessibilityLabel("Ort wird ermittelt")
                }
                if let message = search.resolutionError {
                    Text(message).foregroundStyle(.secondary)
                    if let (suggestion, action) = search.failedResolution {
                        Button("Erneut versuchen") { resolve(suggestion, action: action) }
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func prefill(_ title: String) {
        favoriteError = nil
        search.prefill(title)
        isFocused = true
        textSelection = TextSelection(insertionPoint: search.query.endIndex)
    }

    private func arrow(_ title: String, label: String) -> some View {
        Button { prefill(title) } label: {
            Image(systemName: "arrow.up.left")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) ins Suchfeld übernehmen")
    }

    private func resolve(_ suggestion: PlaceSuggestion, action: PlaceSearchAction) {
        let generation = search.generation
        Task {
            guard generation == search.generation else { return }
            await search.resolve(suggestion, action: action, onResolved: perform)
        }
    }

    private func perform(_ place: Place, action: PlaceSearchAction) {
        switch action {
        case .select:
            search.cancel()
            isFocused = false
            onSelect(place)
        case .favorite:
            favoriteError = nil
            do { try model.setFavorite(place, isFavorite: true) }
            catch { favoriteError = "Favorit konnte nicht gespeichert werden. Bitte erneut versuchen." }
        }
    }

    private func suggestionRow(_ suggestion: PlaceSuggestion) -> some View {
        HStack(spacing: 4) {
            Button { resolve(suggestion, action: .select) } label: {
                HStack(spacing: 14) {
                    if search.resolvingID == suggestion.id {
                        ProgressView().frame(width: 34, height: 34)
                    } else {
                        Image(systemName: "mappin")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(FoldRouteColor.asphalt)
                            .frame(width: 34, height: 34)
                            .background(FoldRouteColor.routeCyan, in: Circle())
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(suggestion.title).font(.headline).foregroundStyle(.primary)
                        if !suggestion.subtitle.isEmpty {
                            Text(suggestion.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(search.isResolving)
            .accessibilityLabel(suggestion.label)
            Button { resolve(suggestion, action: .favorite) } label: {
                Image(systemName: "star")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .disabled(search.isResolving)
            .accessibilityLabel("\(suggestion.label) als Favorit speichern")
            arrow(suggestion.title, label: suggestion.label)
        }
    }

    private func placeButton(_ place: Place, systemImage: String, color: Color) -> some View {
        let stored = recentPlaces.first { $0.id == place.id } ?? recentPlaces.first { $0.matches(place) }
        let isFavorite = stored?.isFavorite == true
        let placeLabel = place.detail.isEmpty ? place.name : "\(place.name), \(place.detail)"
        return HStack(spacing: 4) {
            Button {
                if search.choices.contains(place) {
                    search.choose(place, onResolved: perform)
                } else {
                    perform(place, action: .select)
                }
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(FoldRouteColor.asphalt)
                        .frame(width: 34, height: 34)
                        .background(color, in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(place.name)
                            .font(.headline)
                            .foregroundStyle(.primary)
                        if !place.detail.isEmpty {
                            Text(place.detail)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    if search.searchTerm.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(search.isResolving)
            .accessibilityLabel(placeLabel)

            if place.name != "Aktueller Standort" {
                Button {
                    favoriteError = nil
                    do {
                        try model.setFavorite(place, isFavorite: !isFavorite)
                    } catch {
                        favoriteError = "Favorit konnte nicht gespeichert werden. Bitte erneut versuchen."
                    }
                } label: {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                        .font(.system(size: 22))
                        .foregroundStyle(isFavorite ? FoldRouteColor.signalYellow : Color.secondary)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(search.isResolving)
                .accessibilityLabel(isFavorite ? "\(placeLabel) aus Favoriten entfernen" : "\(placeLabel) als Favorit markieren")
                .accessibilityValue(isFavorite ? "Favorit" : "Kein Favorit")
            }
            if !search.searchTerm.isEmpty {
                arrow(place.name, label: placeLabel)
            }
        }
    }

}
