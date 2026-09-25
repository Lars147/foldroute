import SwiftUI

struct JourneyPreviewView: View {
    var openSettings: () -> Void = {}
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var panel: JourneyPanelState
    @State private var showsAdjustments = false
    @State private var scrollRequest = UUID()
    @State private var scrollTarget = "routeChoices"
    @State private var cameraPanelHeight: CGFloat = 0
    @State var disclosure = JourneyDisclosureState()
    @State private var choiceHeights: [String: CGFloat] = [:]
    @State private var noticesHeight: CGFloat = 0
    @State private var actionsHeight: CGFloat = 112
    @State private var mapActionsHeight: CGFloat = 44
    @State private var headerHeight: CGFloat = 44
    @State private var choiceHeight: CGFloat = 64
    private var options: [Journey] {
        model.journeyOptions.isEmpty ? model.journey.map { [$0] } ?? [] : model.journeyOptions
    }
    private var contentHeight: CGFloat {
        let rows: CGFloat = options.reduce(CGFloat.zero) { total, option in
            total + (choiceHeights[option.id] ?? 64)
        }
        let gaps = CGFloat(max(0, options.count - 1)) * 8
        return rows + gaps + noticesHeight + 16
    }

    var body: some View {
        if let journey = model.journey {
            preview(journey)
                .onChange(of: model.journey?.id) { _, selected in
                    disclosure.reconcile(selectedID: selected, availableIDs: options.map(\.id))
                }
                .onChange(of: options.map(\.id)) { _, ids in
                    disclosure.reconcile(selectedID: model.journey?.id, availableIDs: ids)
                    choiceHeights = choiceHeights.filter { ids.contains($0.key) }
                }
                .onChange(of: model.previewOverviewID) { _, _ in disclosure.close() }
                .onChange(of: model.planningState.isLoading) { _, loading in
                    if loading { disclosure.close() }
                }
                .onDisappear { disclosure.close(); model.location.previewObscured = false }
                .onChange(of: showsAdjustments) { _, shown in model.location.previewObscured = shown }
                .toolbar(.hidden, for: .navigationBar)
                .sheet(isPresented: $showsAdjustments) { RouteAdjustmentView(model: model) }
                .alert("Startpunkt zu weit entfernt", isPresented: distantStartBinding, presenting: distantStartDistance) { _ in
                    Button("Route ab hier planen") { Task { await model.replanFromCurrentLocation() } }
                    Button("Abbrechen", role: .cancel) { model.cancelNavigationPreparation() }
                } message: { distance in
                    Text("Der geplante Start liegt \(distance.formattedDistance) von deinem Standort entfernt.")
                }
        }
    }

    private func preview(_ journey: Journey) -> some View {
        GeometryReader { geometry in
            let available = max(0, geometry.size.height - 8)
            let fixedHeight = headerHeight + actionsHeight + 64
            let fullHeight = dynamicTypeSize.isAccessibilitySize || available - 128 < fixedHeight + choiceHeight
            let heights = JourneyPanelHeights(available: available, summary: headerHeight,
                actions: actionsHeight, content: contentHeight, topClearance: fullHeight ? 0 : 128)
            let mapMode = fullHeight && panel.size == .collapsed
            let coveredMap = fullHeight && !mapMode
            let height = mapMode ? mapActionsHeight + 88 : heights[fullHeight ? .expanded : panel.size]
            let scrollAll = available < fixedHeight + choiceHeight
            let mapPanelHeight = coveredMap || panel.size == .expanded
                ? min(cameraPanelHeight, available * 0.65) : cameraPanelHeight
            ZStack(alignment: .bottom) {
                RouteMapView(
                    journey: journey,
                    alternativeJourneys: model.isReplanningAfterNavigation ? [] : model.journeyOptions,
                    overviewID: model.previewOverviewID,
                    planningPanelMode: "\(panel.size)-\(mapMode)",
                    cameraInsets: MapCameraInsets(top: 64, leading: 24, bottom: mapPanelHeight + 16, trailing: 88),
                    planningLocationInsets: MapCameraInsets(top: 64, leading: 24, bottom: mapPanelHeight + 16, trailing: 88),
                    planningControlsTopY: geometry.frame(in: .global).minY + 12,
                    onJourneySelected: { model.selectJourney(id: $0) },
                    onBackgroundTapped: { changePanel(to: .collapsed, intentional: false) }
                )
                .ignoresSafeArea(edges: .top)
                .accessibilityHidden(coveredMap)
                .allowsHitTesting(!coveredMap)

                ScrollViewReader { proxy in
                    Group {
                        if scrollAll && !mapMode {
                            ScrollView {
                                panelContents(journey, fullHeight: fullHeight, mapMode: false, scrollAll: true)
                            }
                            .scrollBounceBehavior(.basedOnSize)
                            .onScrollPhaseChange { _, phase in
                                if phase == .interacting { model.holdSelectedJourney() }
                            }
                        } else {
                            panelContents(journey, fullHeight: fullHeight, mapMode: mapMode, scrollAll: false)
                        }
                    }
                    .onChange(of: scrollRequest) { _, _ in
                        DispatchQueue.main.async { proxy.scrollTo(scrollTarget, anchor: .top) }
                    }
                }
                .padding(16)
                .frame(height: height)
                .background(FoldRouteColor.asphalt.opacity(fullHeight ? 1 : 0.97), in: RoundedRectangle(cornerRadius: 24))
                .foregroundStyle(.white)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured in
                    if mapMode || (!fullHeight && panel.size != .expanded) { cameraPanelHeight = measured }
                    else if cameraPanelHeight == 0 { cameraPanelHeight = min(measured, available * 0.65) }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
    }

    private func panelContents(_ journey: Journey, fullHeight: Bool, mapMode: Bool, scrollAll: Bool) -> some View {
        VStack(spacing: 12) {
            panelHeader(fullHeight: fullHeight)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if !mapMode { headerHeight = $0 } }
                .fixedSize(horizontal: false, vertical: true)
            if !mapMode {
                if scrollAll {
                    routeContents(journey)
                } else {
                    ScrollView {
                        routeContents(journey)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .onScrollPhaseChange { _, phase in
                        if phase == .interacting { model.holdSelectedJourney() }
                    }
                }
                actions
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(spacing: 8) { mapActions }
                    } else {
                        HStack(spacing: 12) { mapActions }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { mapActionsHeight = $0 }
            }
        }
    }

    private func routeContents(_ journey: Journey) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.isReplanningAfterNavigation {
                Text("Neue Routen nach \(model.destination?.name ?? journey.destination.name)").font(.headline)
            } else {
                choices.id("routeChoices")
            }
            reservedAlternativeContent(journey) { option in
                VStack(alignment: .leading, spacing: 16) {
                    if let comparison = CyclingComparison.label(option, limit: model.resultCyclingLimit) {
                        Text(comparison).font(.caption).foregroundStyle(FoldRouteColor.signalYellow)
                    }
                    planningNotices(option)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { noticesHeight = $0 }
        }
        .frame(maxWidth: .infinity, alignment: .leading)

    }

    private func reservedAlternativeContent<Content: View>(_ selected: Journey,
        @ViewBuilder content: @escaping (Journey) -> Content) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(model.journeyOptions) { route in
                content(route).hidden().accessibilityHidden(true).allowsHitTesting(false)
            }
            content(selected)
        }
    }

    private func panelHeader(fullHeight: Bool) -> some View {
        VStack(spacing: 0) {
            Capsule().fill(.white.opacity(0.4)).frame(width: 38, height: 4)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 20).onEnded { value in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    resizePanel(growing: value.translation.height < 0)
                })
                .accessibilityElement()
                .accessibilityLabel("Größe der Routenübersicht")
                .accessibilityValue(panel.size.title)
                .accessibilityIdentifier("journeyPanelHandle")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: resizePanel(growing: true)
                    case .decrement: resizePanel(growing: false)
                    @unknown default: break
                    }
                }
                .accessibilityAction(named: "Minimieren") { changePanel(to: .collapsed) }
                .accessibilityAction(named: "Maximieren") { changePanel(to: .expanded) }
            if fullHeight && panel.size != .collapsed {
                HStack(alignment: .top) {
                    Button { changePanel(to: panel.size == .collapsed ? .normal : .collapsed) } label: {
                        if dynamicTypeSize.isAccessibilitySize {
                            Image(systemName: panel.size == .collapsed ? "list.bullet.rectangle" : "map")
                                .font(.system(size: 20, weight: .semibold))
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        } else {
                            Text(panel.size == .collapsed ? "Reise anzeigen" : "Karte anzeigen")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(panel.size == .collapsed ? "Reise anzeigen" : "Karte anzeigen")
                    .accessibilityIdentifier("toggleJourneyMap")
                }
            }
        }
    }

    private func resizePanel(growing: Bool) {
        changePanel(to: growing ? (panel.size == .collapsed ? .normal : .expanded)
            : (panel.size == .expanded ? .normal : .collapsed))
    }

    private var choices: some View {
        return VStack(spacing: 8) {
            ForEach(options) { option in
                let comparison = CyclingComparison.excess(option, limit: model.resultCyclingLimit) > 0
                let selected = option.id == model.journey?.id
                let open = disclosure.openedID == option.id
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Button {
                            disclosure.reconcile(selectedID: option.id, availableIDs: options.map(\.id))
                            model.selectJourney(id: option.id)
                        } label: {
                            choiceCopy(option, comparison: comparison, showOutline: !open)
                                .overlay(alignment: .topLeading) {
                                    // Measure the closed card independently of visible disclosure.
                                    choiceCopy(option, comparison: comparison, showOutline: true)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .hidden().accessibilityHidden(true).allowsHitTesting(false)
                                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured in
                                            choiceHeights[option.id] = measured
                                            if option.id == options.first?.id { choiceHeight = measured }
                                        }
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(optionTitle(option)). Abfahrt \(option.departure.formatted(date: .abbreviated, time: .shortened)), Ankunft \(option.arrival.formatted(date: .abbreviated, time: .shortened)), Gesamtdauer \(option.duration.formattedDuration). \(JourneyEffort(option).label). \(option.routeOutline)")
                        .accessibilityAddTraits(selected ? [.isSelected] : [])
                        .accessibilityIdentifier("journeyChoice-\(option.id)")
                        Button {
                            let previouslyOpen = disclosure.openedID
                            disclosure.toggle(option.id)
                            model.selectJourney(id: option.id)
                            model.holdSelectedJourney()
                            if let previouslyOpen, previouslyOpen != option.id {
                                scrollTarget = "routeChoice-" + option.id
                                scrollRequest = UUID()
                            }
                        } label: {
                            Image(systemName: "chevron.right")
                                .rotationEffect(.degrees(open ? 180 : 0))
                                .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: open)
                                .frame(width: 44, height: 44)
                                .frame(maxHeight: .infinity)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .leading) { Rectangle().fill(.primary.opacity(0.4)).frame(width: 1) }
                        .accessibilityLabel("Reiseabschnitte \(open ? "schließen" : "öffnen"): \(option.arrival.formatted(date: .omitted, time: .shortened)), \(option.routeOutline)")
                        .accessibilityValue(open ? "Geöffnet" : "Geschlossen")
                        .accessibilityIdentifier("journeyDetails-" + option.id)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .background(selected ? FoldRouteColor.signalYellow : .white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(selected ? FoldRouteColor.asphalt : .white)
                    .id("routeChoice-" + option.id)
                    if open {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("\((option.bikeDistance / 1000).formatted(.number.precision(.fractionLength(0...1)))) km Rad")
                                .font(.caption).foregroundStyle(.secondary)
                            ForEach(option.legs) { JourneyLegRow(leg: $0) }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.03))
                        .accessibilityIdentifier("journeyExpandedDetails-" + option.id)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Verbindung auswählen")
    }

    private func choiceCopy(_ option: Journey, comparison: Bool, showOutline: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if comparison { Image(systemName: "bicycle").accessibilityHidden(true) }
                Text("\(journeyTimeRange(option)) · \(option.duration.formattedDuration)")
                    .font(.subheadline.weight(.semibold))
            }
            if showOutline { Text(option.routeOutline).font(.caption.weight(.semibold)) }
            Text(JourneyEffort(option).label).font(.caption)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func planningNotices(_ journey: Journey) -> some View {
        if let notice = model.fallbackNotice {
            Label(notice, systemImage: "exclamationmark.triangle").font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("fallbackNotice")
        }
        if model.planningState.isLoading {
            ProgressView(model.planningState == .locating ? "Standort wird ermittelt …" : "Routen werden neu berechnet …")
        } else if model.bikeTransferSearchStatus == .searching {
            ProgressView("Verbindungen optimieren …").font(.caption)
        }
        if let notice = model.planningNotice { Text(notice).font(.footnote).fixedSize(horizontal: false, vertical: true) }
        if case .failed(let message) = model.planningState, model.fallbackNotice == nil {
            Text(model.planningFailureMessage(message)).font(.footnote)
        }
        if let delay = model.lateDepartureDelay(for: journey) {
            Text("Start erst \(lateDepartureTime(journey.departure)) – \(delay.formattedDuration) nach dem gewünschten Beginn. Größere Suchgrenzen können frühere Verbindungen ermöglichen.")
                .font(.caption).fixedSize(horizontal: false, vertical: true)
            Button("Einstellungen anpassen", action: openSettings).frame(minHeight: 44)
        }
        if model.bikeTransferSearchStatus != .searching, !model.journeyOptions.isEmpty,
           model.journeyOptions.allSatisfy({ CyclingComparison.excess($0, limit: model.resultCyclingLimit) > 0 }) {
            Text("Keine Verbindung innerhalb deines Radlimits gefunden. Fahrradroute zum Vergleich.").font(.caption)
        }
        if case .failed(let message) = model.navigationStartState {
            Label(message, systemImage: "exclamationmark.triangle.fill").font(.footnote)
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { planningActions }
            } else {
                HStack(spacing: 12) { planningActions }
            }
            if !model.isReplanningAfterNavigation {
                Button {
                    Task { await model.startNavigation() }
                } label: {
                    Group {
                        if dynamicTypeSize.isAccessibilitySize {
                            Text(startButtonTitle)
                        } else {
                            Label(startButtonTitle, systemImage: "location.north.fill")
                        }
                    }
                    .font(.headline).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(FoldRouteColor.signalYellow)
                .foregroundStyle(FoldRouteColor.asphalt)
                .disabled(model.navigationStartState.isLoading || model.planningState.isLoading)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { actionsHeight = $0 }
    }

    private var closeAction: some View {
        Button { model.discardRoute() } label: {
            Text("Schließen").fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("Route schließen")
    }

    @ViewBuilder
    private var mapActions: some View {
        Button { changePanel(to: .normal) } label: {
            Text("Reise anzeigen").fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .accessibilityIdentifier("toggleJourneyMap")
        closeAction
    }

    @ViewBuilder
    private var planningActions: some View {
        Button { showsAdjustments = true } label: {
            Text("Route anpassen").fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(FoldRouteColor.signalYellow)
        .foregroundStyle(FoldRouteColor.asphalt)
        .disabled(model.planningState.isLoading || model.navigationStartState.isLoading)
        closeAction
    }

    private func optionTitle(_ journey: Journey) -> String {
        if CyclingComparison.excess(journey, limit: model.resultCyclingLimit) > 0 { return "Fahrradvergleich" }
        if journey.id == model.recommendedJourney?.id {
            return (model.previewTiming ?? model.routeTiming).isArrival ? "Späteste Abfahrt" : "Früheste Ankunft"
        }
        return "Alternative"
    }

    private func changePanel(to size: JourneyPanelSize, intentional: Bool = true) {
        if intentional { model.holdSelectedJourney() }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { panel.set(size) }
    }

    private var startButtonTitle: String {
        switch model.navigationStartState {
        case .locating: "Standort wird geprüft …"
        case .preparingApproach: "Route zum Start wird geplant …"
        default: model.fallbackNotice == nil ? "Navigation starten" : "Bisherige Route starten"
        }
    }

    private var distantStartDistance: Double? {
        if case .distantStart(let distance) = model.navigationStartState { return distance }
        return nil
    }
    private var distantStartBinding: Binding<Bool> {
        Binding(get: { distantStartDistance != nil }, set: { if !$0 { model.cancelNavigationPreparation() } })
    }
}

struct JourneyEffort: Equatable {
    let cyclingMinutes: Int
    let walkingMinutes: Int
    let transfers: Int

    init(_ journey: Journey) {
        func minutes(_ kinds: Set<JourneyLegKind>) -> Int {
            max(0, Int((journey.legs.filter { kinds.contains($0.kind) }
                .reduce(0) { $0 + max(0, $1.endTime.timeIntervalSince($1.startTime)) } / 60).rounded(.up)))
        }
        cyclingMinutes = minutes([.bike, .approach])
        walkingMinutes = minutes([.walk])
        transfers = journey.transfers
    }
    var label: String { "\(cyclingMinutes) min Rad · \(walkingMinutes) min Fuß · \(transfers) \(transfers == 1 ? "Umstieg" : "Umstiege")" }
}

struct JourneyLegRow: View {
    let leg: JourneyLeg

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: leg.kind.symbol)
                .foregroundStyle(leg.kind.color)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Text(leg.startTime, format: .dateTime.hour().minute())
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.white.opacity(0.82))
        }
    }

    private var title: String {
        switch leg {
        case .approach(let value): "Zum Start bei \(value.to.name)"
        case .bike(let value): "Rad bis \(value.to.name)"
        case .walk(let value): "Zu Fuß bis \(value.to.name)"
        case .fold: "Rad falten"
        case .unfold: "Rad entfalten"
        case .wait: "Auf Weiterfahrt warten"
        case .stop(let value): "Zwischenziel: \(value.place.name)"
        case .transit(let value): "\(value.line) – \(value.from.name)"
        }
    }

    private var detail: String {
        switch leg {
        case .approach(let value), .bike(let value), .walk(let value): value.distance.formattedDistance
        case .stop(let value): "\(value.stop?.stayMinutes ?? 0) Min. Aufenthalt · Weiterfahrt \(value.endTime.formatted(date: .omitted, time: .shortened))"
        case .fold, .unfold, .wait: leg.endTime.timeIntervalSince(leg.startTime).formattedDuration
        case .transit(let value):
            value.to.name
        }
    }
}

extension TimeInterval {
    var formattedDuration: String {
        let minutes = max(1, Int((self / 60).rounded(.up)))
        if minutes < 60 { return "\(minutes) Min."
        }
        return "\(minutes / 60) Std. \(minutes % 60) Min."
    }
}

extension Double {
    var formattedDistance: String {
        if self < 1_000 { return "\(Int(self.rounded())) m" }
        return String(format: "%.1f km", locale: Locale(identifier: "de_DE"), self / 1_000)
    }
}

enum JourneyPanelSize: CaseIterable {
    case collapsed, normal, expanded

    var title: String {
        switch self {
        case .collapsed: "Minimiert"
        case .normal: "Normal"
        case .expanded: "Maximiert"
        }
    }
}

struct JourneyPanelState {
    private(set) var size: JourneyPanelSize = .normal
    private(set) var lastOpenSize: JourneyPanelSize = .normal

    mutating func set(_ newSize: JourneyPanelSize) {
        size = newSize
        if newSize != .collapsed { lastOpenSize = newSize }
    }

}

struct JourneyPanelHeights {
    let collapsed: CGFloat
    let normal: CGFloat
    let expanded: CGFloat

    init(available: CGFloat, summary: CGFloat, actions: CGFloat, content: CGFloat = 350,
         topClearance: CGFloat = 16) {
        expanded = max(0, available - topClearance)
        collapsed = min(expanded, summary + min(170, content) + actions + 60)
        normal = min(expanded, summary + content + actions + 60)
    }

    subscript(size: JourneyPanelSize) -> CGFloat {
        switch size {
        case .collapsed: collapsed
        case .normal: normal
        case .expanded: expanded
        }
    }

    func nearest(to height: CGFloat) -> JourneyPanelSize {
        JourneyPanelSize.allCases.min { abs(self[$0] - height) < abs(self[$1] - height) } ?? .normal
    }
}

private func lateDepartureTime(_ date: Date) -> String {
    if Calendar.current.isDateInToday(date) {
        return "um " + date.formatted(date: .omitted, time: .shortened)
    }
    return "am " + date.formatted(date: .numeric, time: .shortened)
}


func journeyTimeRange(_ journey: Journey, calendar: Calendar = .current, now: Date = Date()) -> String {
    let departure = journey.departure.formatted(date: .omitted, time: .shortened)
    let arrival = journey.arrival.formatted(date: .omitted, time: .shortened)
    if !calendar.isDate(journey.departure, inSameDayAs: journey.arrival) {
        return "\(journey.departure.formatted(date: .abbreviated, time: .omitted)) \(departure) → \(journey.arrival.formatted(date: .abbreviated, time: .omitted)) \(arrival)"
    }
    let day = calendar.isDate(journey.departure, inSameDayAs: now) ? "" : "\(journey.departure.formatted(date: .abbreviated, time: .omitted)) · "
    return "\(day)\(departure) → \(arrival)"
}

/// Disclosure is independent of panel size and never changes route selection itself.
struct JourneyDisclosureState: Equatable {
    private(set) var openedID: String?

    mutating func toggle(_ id: String) {
        openedID = openedID == id ? nil : id
    }

    mutating func close() { openedID = nil }

    mutating func reconcile(selectedID: String?, availableIDs: [String]) {
        if openedID != selectedID || !availableIDs.contains(where: { $0 == openedID }) {
            close()
        }
    }
}
