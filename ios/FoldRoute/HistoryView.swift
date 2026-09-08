import SwiftData
import SwiftUI

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @Query(sort: \StoredJourney.completedAt, order: .reverse) private var journeys: [StoredJourney]
    @State private var errorMessage: String?

    let openRouteTab: () -> Void

    var body: some View {
        Group {
            if journeys.isEmpty {
                ContentUnavailableView(
                    "Noch keine Fahrten",
                    systemImage: "bicycle",
                    description: Text("Abgeschlossene Routen erscheinen hier – ohne gespeicherte GPS-Spur.")
                )
            } else {
                List(journeys) { journey in
                    if journey.isReplannable {
                        Button {
                            replan(journey)
                        } label: {
                            journeyRow(journey)
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button {
                                replan(journey, reversed: true)
                            } label: {
                                Label("Umkehren", systemImage: "arrow.left.arrow.right")
                            }
                            .tint(FoldRouteColor.signalYellow)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            deleteButton(for: journey)
                        }
                    } else {
                        journeyRow(journey)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                deleteButton(for: journey)
                            }
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Fahrten")
        .alert("Aktion fehlgeschlagen", isPresented: errorIsPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "Unbekannter Fehler")
        }
        .task {
            await model.refreshHistoryPlaceNames(journeys)
        }
    }

    private var errorIsPresented: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { isPresented in
                if !isPresented { errorMessage = nil }
            }
        )
    }

    private func journeyRow(_ journey: StoredJourney) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(journey.destinationName)
                    .font(.headline)
                Spacer()
                Text(journey.duration.formattedDuration)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                if journey.isReplannable {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            Text("\(journey.originName) → \(journey.destinationName)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack {
                Text(journey.completedAt, format: .dateTime.day().month().year().hour().minute())
                Spacer()
                if journey.isReplannable {
                    Text(modeSummary(journey.modes))
                } else {
                    Label("Alte Fahrt · nur Anzeige", systemImage: "info.circle")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 5)
    }

    private func deleteButton(for journey: StoredJourney) -> some View {
        Button(role: .destructive) {
            do {
                try model.deleteHistoryEntry(id: journey.id)
            } catch {
                errorMessage = "Fahrt konnte nicht gelöscht werden."
            }
        } label: {
            Label("Löschen", systemImage: "trash")
        }
        .tint(.red)
    }

    private func replan(_ journey: StoredJourney, reversed: Bool = false) {
        guard let storedOrigin = journey.originPlace,
              let storedDestination = journey.destinationPlace else {
            errorMessage = "Diese alte Fahrt enthält keine erneut planbaren Ortsdaten."
            return
        }

        let origin = reversed ? storedDestination : storedOrigin
        let destination = reversed ? storedOrigin : storedDestination
        openRouteTab()
        Task { await model.replan(from: origin, to: destination) }
    }

    private func modeSummary(_ rawModes: String) -> String {
        rawModes
            .split(separator: ",")
            .compactMap { JourneyLegKind(rawValue: String($0))?.title }
            .reduce(into: [String]()) { result, item in
                if result.last != item { result.append(item) }
            }
            .joined(separator: " · ")
    }
}
