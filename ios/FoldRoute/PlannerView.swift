import SwiftUI

struct PlannerView: View {
    var openSettings: () -> Void = {}
    @Environment(AppModel.self) private var model
    @State private var showsAdjustments = false
    @State private var panel = JourneyPanelState()

    var body: some View {
        Group {
            if model.journey != nil {
                JourneyPreviewView(openSettings: openSettings, panel: $panel)
            } else if model.isPreviewReplan {
                previewReplanning
            } else {
                PlaceSearchContent(target: .destination, isDisabled: model.planningState.isLoading) { place in
                    Task { await model.planToDestination(place) }
                }
                .safeAreaInset(edge: .bottom) { planningStatus }
                .navigationTitle("FoldRoute")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .onChange(of: model.destination == nil) { _, isEmpty in
            if isEmpty { panel = JourneyPanelState() }
        }
        .sheet(isPresented: $showsAdjustments) {
            RouteAdjustmentView(model: model)
        }
    }

    private var previewReplanning: some View {
        RouteMapView(journey: nil, idleCenterCoordinate: model.origin?.coordinate)
            .ignoresSafeArea(edges: .top)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Route aktualisieren")
                            .font(.headline)
                        Spacer()
                        Button { model.discardRoute() } label: {
                            Image(systemName: "xmark")
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Route schließen")
                    }
                    if let destination = model.destination {
                        Text("Nach \(destination.name)")
                            .font(.subheadline)
                    }
                    if case .failed(let message) = model.planningState {
                        Label(model.planningFailureMessage(message), systemImage: "exclamationmark.triangle")
                            .fixedSize(horizontal: false, vertical: true)
                        if let destination = model.destination {
                            ViewThatFits(in: .horizontal) {
                                HStack { recoveryButtons(destination: destination) }
                                VStack(alignment: .leading) { recoveryButtons(destination: destination) }
                            }
                        }
                    } else {
                        // Settings invalidation is synchronous; the replan task starts later.
                        // Cover that idle interval as well as locating/loading without showing search.
                        ProgressView(model.planningState == .locating
                            ? "Standort wird ermittelt …"
                            : "Routen werden neu berechnet …")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .cockpitPanel()
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .accessibilityIdentifier("previewReplanningStatus")
            }
            .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder
    private var planningStatus: some View {
        if model.planningState.isLoading {
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(model.planningState == .locating ? "Standort wird ermittelt …" : "Route wird berechnet …")
                if let destination = model.destination {
                    Text("Nach \(destination.name)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(.bar)
        } else if case .failed(let message) = model.planningState {
            VStack(alignment: .leading, spacing: 12) {
                Label(model.planningFailureMessage(message), systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .accessibilityLabel("Fehler: \(model.planningFailureMessage(message))")
                if let destination = model.destination {
                    ViewThatFits(in: .horizontal) {
                        HStack { recoveryButtons(destination: destination) }
                        VStack(alignment: .leading) { recoveryButtons(destination: destination) }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(.bar)
        }
    }

    @ViewBuilder
    private func recoveryButtons(destination: Place) -> some View {
        Button("Erneut versuchen") {
            if model.isPreviewReplan { model.retryPreviewPlanning() }
            else { Task { await model.planToDestination(destination) } }
        }
        .disabled(model.planningRequestsPaused)
        .buttonStyle(.borderedProminent)
        .tint(FoldRouteColor.signalYellow)
        .foregroundStyle(FoldRouteColor.asphalt)
        Button(model.origin == nil ? "Start wählen" : "Route anpassen") {
            showsAdjustments = true
        }
        .buttonStyle(.bordered)
    }
}

struct RouteAdjustmentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var origin: Place?
    @State private var destination: Place?
    @State private var timing: TimingSelection
    @State private var date: Date
    @State private var showsStartSearch = false
    @State private var showsDestinationSearch = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(model: AppModel) {
        _origin = State(initialValue: model.isReplanningAfterNavigation ? model.origin : model.journey?.origin ?? model.origin)
        _destination = State(initialValue: model.journey?.destination ?? model.destination)
        _timing = State(initialValue: model.timingSelection)
        _date = State(initialValue: max(model.plannedDate, Date().addingTimeInterval(60)))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Start") {
                    Button {
                        showsStartSearch = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: origin?.name == "Aktueller Standort" ? "location.fill" : "mappin")
                                .foregroundStyle(FoldRouteColor.routeCyan)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(origin?.name ?? "Start wählen")
                                    .foregroundStyle(.primary)
                                if let detail = origin?.detail, !detail.isEmpty {
                                    Text(detail)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 52)
                    }
                    .accessibilityLabel("Start wählen: \(origin?.name ?? "Nicht gewählt")")
                }
                Section {
                    Button {
                        showsDestinationSearch = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: destination?.name == "Aktueller Standort" ? "location.fill" : "flag.checkered")
                                .foregroundStyle(destination?.name == "Aktueller Standort" ? FoldRouteColor.routeCyan : FoldRouteColor.signalYellow)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(destination?.name ?? "Ziel wählen")
                                    .foregroundStyle(.primary)
                                if let detail = destination?.detail, !detail.isEmpty {
                                    Text(detail)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 52)
                    }
                    .accessibilityLabel("Ziel wählen: \(destination?.name ?? "Nicht gewählt")")
                } header: {
                    ZStack {
                        Text("Ziel")
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            (origin, destination) = (destination, origin)
                            errorMessage = nil
                        } label: {
                            Image(systemName: "arrow.up.arrow.down")
                                .font(.title3.weight(.semibold))
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.borderless)
                        .disabled(origin == nil || destination == nil)
                        .accessibilityLabel("Start und Ziel tauschen")
                        .accessibilityIdentifier("swapRouteEndpoints")
                    }
                    .textCase(nil)
                }
                Section("Zeit") {
                    Picker("Zeit", selection: $timing) {
                        ForEach(TimingSelection.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    if timing != .now {
                        DatePicker(
                            timing == .depart ? "Abfahrt" : "Ankunft",
                            selection: $date,
                            in: Date()...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                    }
                }
                if let errorMessage {
                    Section {
                        Label(model.planningFailureMessage(errorMessage), systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.primary)
                            .accessibilityLabel("Fehler: \(model.planningFailureMessage(errorMessage))")
                    }
                }
            }
            .disabled(isSubmitting)
            .safeAreaInset(edge: .bottom) {
                Button {
                    applyDraft()
                } label: {
                    HStack {
                        if isSubmitting { ProgressView().tint(FoldRouteColor.asphalt) }
                        Text(model.planningPauseMessage ?? (isSubmitting ? "Route wird berechnet …" : "Route berechnen"))
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity, minHeight: 54)
                }
                .buttonStyle(.borderedProminent)
                .tint(FoldRouteColor.signalYellow)
                .foregroundStyle(FoldRouteColor.asphalt)
                .disabled(origin == nil || destination == nil || isSubmitting || model.planningState.isLoading || model.planningRequestsPaused)
                .padding(16)
                .background(.bar)
            }
            .navigationTitle("Route anpassen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                        .disabled(isSubmitting)
                }
            }
            .sheet(isPresented: $showsStartSearch) {
                PlaceSearchView(target: .origin) { origin = $0 }
            }
            .sheet(isPresented: $showsDestinationSearch) {
                PlaceSearchView(target: .destination) {
                    destination = $0
                    errorMessage = nil
                }
            }
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    private func applyDraft() {
        guard let origin, let destination, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            errorMessage = await model.applyRouteAdjustments(
                origin: origin,
                destination: destination,
                timingSelection: timing,
                plannedDate: date
            )
            isSubmitting = false
            if errorMessage == nil { dismiss() }
        }
    }
}
