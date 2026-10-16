import SwiftUI

struct SharedDestinationView: View {
    let item: PendingSharedDestination
    let onSelect: (Place) -> Void
    let onDiscard: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var submitted = false

    private var destination: SharedDestination { SharedDestination.parse(item.payload) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                if destination.kind == "place" {
                    ProgressView("Ziel wird übernommen …")
                        .task {
                            guard !submitted, let latitude = destination.latitude, let longitude = destination.longitude else { return }
                            submitted = true
                            onSelect(Place(name: destination.name ?? "Geteiltes Ziel",
                                           coordinate: Coordinate(latitude: latitude, longitude: longitude)))
                        }
                } else {
                    if destination.kind != "query" {
                        Text(destination.kind == "invalid" ? "Geteiltes Ziel ungültig. Bitte Ziel eingeben." : SharedDestination.unsupportedMessage)
                            .font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
                    }
                    PlaceSearchContent(target: .destination, showCurrentLocation: false,
                                       initialQuery: destination.query ?? "", autoSelectSingle: true, onSelect: onSelect)
                    Button("Geteiltes Ziel verwerfen") { onDiscard(); dismiss() }
                        .frame(minHeight: 44)
                }
            }
            .navigationTitle("Geteiltes Ziel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } } }
        }
    }
}
