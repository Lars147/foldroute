import SwiftUI

struct PlannerView: View {
    var openSettings: () -> Void = {}
    @Environment(AppModel.self) private var model
    @State private var showsAdjustments = false
    @State private var searchFocused = false
    @State private var panel = JourneyPanelState()

    var body: some View {
        Group {
            if model.journey != nil {
                JourneyPreviewView(openSettings: openSettings, panel: $panel)
            } else if model.isPreviewReplan {
                previewReplanning
            } else {
                PlaceSearchContent(target: .destination, showCurrentLocation: false, isDisabled: model.planningState.isLoading, onFocusChanged: { searchFocused = $0 }) { place in
                    Task { await model.planToDestination(place) }
                }
                .toolbar(searchFocused ? .hidden : .visible, for: .tabBar)
                .safeAreaInset(edge: .bottom) {
                    if !searchFocused {
                        VStack(spacing: 0) {
                            Button("Start, Zeit & Zwischenstopps") { showsAdjustments = true }
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .buttonStyle(.bordered)
                                .padding(.horizontal, 16)
                                .disabled(model.planningState.isLoading)
                                .accessibilityIdentifier("prepareRoute")
                            planningStatus
                        }
                        .background(.bar)
                    }
                }
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
    @State private var stops: [RouteStop]
    @State private var showsTimePicker = false
    @State private var showsStopSearch = false
    @State private var editingStopID: String?
    @State private var showsStartSearch = false
    @State private var showsDestinationSearch = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(model: AppModel) {
        _stops = State(initialValue: model.routeStops)
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
                Section("Zwischenziele") {
                    ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                        VStack(alignment: .leading, spacing: 10) {
                            Button("\(index+1). \(stop.place.name)") { editingStopID = stop.id; showsStopSearch = true }
                            Stepper("Aufenthalt: \(stop.stayMinutes) Minuten", value: Binding(
                                get: { stops.first(where: { $0.id == stop.id })?.stayMinutes ?? 0 },
                                set: { value in
                                    if let current = stops.firstIndex(where: { $0.id == stop.id }) {
                                        stops[current].stayMinutes = value
                                    }
                                }
                            ), in: 0...1440)
                            HStack {
                                Button { moveStop(stop.id, by: -1) } label: { Image(systemName: "arrow.up") }
                                    .disabled(index == 0).accessibilityLabel("Zwischenziel \(index+1) nach oben")
                                Button { moveStop(stop.id, by: 1) } label: { Image(systemName: "arrow.down") }
                                    .disabled(index == stops.count-1).accessibilityLabel("Zwischenziel \(index+1) nach unten")
                                Spacer()
                                Button("Entfernen") { stops.removeAll { $0.id == stop.id } }
                                    .accessibilityLabel("Zwischenziel \(index+1) entfernen")
                            }.buttonStyle(.borderless)
                        }
                    }
                    Button("Zwischenziel hinzufügen") { editingStopID = nil; showsStopSearch = true }
                        .disabled(stops.count >= 3)
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
                            stops.reverse()
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
                    Button { showsTimePicker = true } label: {
                        HStack {
                            Image(systemName: "calendar")
                            Text(timing == .now ? "Jetzt" : "\(date.formatted(date: .abbreviated, time: .omitted)), \(timing == .arrive ? "an" : "ab") \(date.formatted(date: .omitted, time: .shortened))")
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .frame(minHeight: 44)
                    }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("timeSelection")
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
            .navigationTitle("Start, Zeit & Zwischenstopps")
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
            .sheet(isPresented: $showsStopSearch) {
                PlaceSearchView(target: .stop) { place in
                    if let id = editingStopID, let i = stops.firstIndex(where: { $0.id == id }) { stops[i].place = place }
                    else if stops.count < 3 { stops.append(RouteStop(place: place)) }
                    errorMessage = nil
                }
            }
            .sheet(isPresented: $showsTimePicker) {
                RouteTimePicker(timing: timing, date: date) { selection, selectedDate in
                    timing = selection
                    date = selectedDate
                }
                .presentationDetents([.large])
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

    private func moveStop(_ id: String, by offset: Int) {
        guard let index = stops.firstIndex(where: { $0.id == id }),
              stops.indices.contains(index + offset) else { return }
        stops.swapAt(index, index + offset)
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
                plannedDate: date,
                stops: stops
            )
            isSubmitting = false
            if errorMessage == nil { dismiss() }
        }
    }
}


struct RouteTimePicker: View {
    @Environment(\.dismiss) private var dismiss
    @State private var timing: TimingSelection
    @State private var date: Date
    @State private var clock = Date()
    let onApply: (TimingSelection, Date) -> Void

    init(timing: TimingSelection, date: Date, onApply: @escaping (TimingSelection, Date) -> Void) {
        _timing = State(initialValue: timing)
        _date = State(initialValue: date)
        self.onApply = onApply
    }

    private var selectedDate: Binding<Date> {
        Binding(get: { timing == .now ? clock : date }, set: { value in
            date = value
            if timing == .now { timing = .depart }
        })
    }
    private var mode: Binding<TimingSelection> {
        Binding(get: { timing == .now ? .depart : timing }, set: { value in
            if timing == .now { date = clock }
            timing = value
        })
    }
    private var valid: Bool { timing == .now || date >= clock }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Zeitmodus", selection: mode) {
                        Text("Abfahrt").tag(TimingSelection.depart)
                        Text("Ankunft").tag(TimingSelection.arrive)
                    }
                    .pickerStyle(.segmented)
                    DatePicker("Datum", selection: selectedDate, in: Calendar.current.startOfDay(for: clock)..., displayedComponents: .date)
                        .datePickerStyle(.graphical)
                        .padding(.horizontal, -20)
                    Text("Uhrzeit").font(.headline)
                    DatePicker("Uhrzeit", selection: selectedDate, displayedComponents: .hourAndMinute)
                        .datePickerStyle(.wheel)
                        .labelsHidden()
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, -20)
                    Button("Jetzt") { clock = Date(); timing = .now }
                        .buttonStyle(.bordered)
                        .frame(minHeight: 44)
                        .accessibilityAddTraits(timing == .now ? [.isSelected] : [])
                    Text(timing == .now ? "Der aktuelle Zeitpunkt wird bei der Berechnung bestimmt." : "Fester Zeitpunkt")
                        .font(.footnote).foregroundStyle(.secondary)
                    if !valid {
                        Text("Bitte einen zukünftigen Zeitpunkt wählen.").accessibilityIdentifier("timeSelectionError")
                    }
                }
                .padding(20)
            }
            .navigationTitle("Zeitpunkt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(uiColor: .systemBackground), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button("Übernehmen") {
                    clock = Date()
                    guard timing == .now || date >= clock else { return }
                    onApply(timing, timing == .now ? clock : date)
                    dismiss()
                }
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(FoldRouteColor.signalYellow, in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(FoldRouteColor.asphalt)
                .disabled(!valid)
                .padding(16)
                .background(.bar)
            }
        }
        .environment(\.locale, Locale(identifier: "de_DE"))
        .task {
            while !Task.isCancelled {
                clock = Date()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
    }
}
