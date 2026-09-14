import SwiftUI

struct JourneyPreviewView: View {
    var openSettings: () -> Void = {}
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var panel: JourneyPanelState
    @State private var showsAdjustments = false
    @State private var cameraPanelHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 320
    @State private var actionsHeight: CGFloat = 112
    @State private var headerHeight: CGFloat = 44
    @State private var lastHandleDrag = Date.distantPast

    var body: some View {
        if let journey = model.journey {
            GeometryReader { geometry in
                let available = max(0, geometry.size.height - 8)
                let fullHeight = dynamicTypeSize.isAccessibilitySize || available < 500
                let heights = JourneyPanelHeights(available: available, summary: headerHeight,
                    actions: actionsHeight, content: contentHeight, topClearance: fullHeight ? 0 : 128)
                let mapMode = fullHeight && panel.size == .collapsed
                let coveredMap = fullHeight && !mapMode
                let height = mapMode ? headerHeight + 32 : heights[fullHeight ? .expanded : panel.size]
                let scrollActions = fullHeight || headerHeight + actionsHeight + 240 > height
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

                    VStack(spacing: 12) {
                        panelHeader(fullHeight: fullHeight)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
                        if !mapMode {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 16) {
                                    if model.isReplanningAfterNavigation {
                                        Text("Neue Routen nach \(model.destination?.name ?? journey.destination.name)").font(.headline)
                                    } else {
                                        choices
                                        reservedAlternativeContent(journey) { summary($0) }
                                        if panel.size == .expanded {
                                            FoldLine(legs: journey.legs)
                                            ForEach(journey.legs) { JourneyLegRow(leg: $0) }
                                        }
                                    }
                                    reservedAlternativeContent(journey) { planningNotices($0) }
                                    if scrollActions { actions }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                                    if !scrollActions { contentHeight = $0 }
                                }
                            }
                            .scrollBounceBehavior(.basedOnSize)
                            .onScrollPhaseChange { _, phase in
                                if phase == .interacting { model.holdSelectedJourney() }
                            }
                            if !scrollActions { actions }
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
        HStack(alignment: .top) {
            if fullHeight {
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
            if !fullHeight || panel.size != .collapsed {
                Button {
                    guard Date().timeIntervalSince(lastHandleDrag) > 0.35 else { return }
                    changePanel(to: panel.size == .expanded ? .normal : .expanded)
                } label: {
                    if fullHeight {
                        Image(systemName: "list.bullet.rectangle")
                            .font(.system(size: 20, weight: .semibold))
                            .frame(width: 44, height: 44)
                    } else {
                        Label(panel.size == .expanded ? "Weniger Details" : "Mehr Details", systemImage: "chevron.up.chevron.down")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(panel.size == .expanded ? "Weniger Details" : "Mehr Details")
                .accessibilityIdentifier("journeyPanelHandle")
                .accessibilityValue(panel.size.title)
                .accessibilityAction(named: "Minimieren") { changePanel(to: .collapsed) }
                .accessibilityAction(named: "Maximieren") { changePanel(to: .expanded) }
                .simultaneousGesture(DragGesture(minimumDistance: 20).onEnded { value in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    lastHandleDrag = Date()
                    changePanel(to: value.translation.height < 0 ? .expanded : .collapsed)
                })
            }
            Button { model.discardRoute() } label: {
                Image(systemName: "xmark").font(.system(size: 20, weight: .semibold)).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Route schließen")
        }
    }

    private func summary(_ journey: Journey) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(optionTitle(journey)).font(.caption.weight(.semibold)).foregroundStyle(FoldRouteColor.signalYellow)
            JourneyTimeSummary(journey: journey)
            if let comparison = CyclingComparison.label(journey, limit: model.resultCyclingLimit) {
                Text(comparison).font(.caption).foregroundStyle(FoldRouteColor.signalYellow)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .simultaneousGesture(DragGesture(minimumDistance: 40).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height),
                  let index = model.journeyOptions.firstIndex(where: { $0.id == journey.id }),
                  !model.journeyOptions.isEmpty else { return }
            let count = model.journeyOptions.count
            let next = (index + (value.translation.width < 0 ? 1 : count - 1)) % count
            model.selectJourney(id: model.journeyOptions[next].id)
        })
    }

    private var choices: some View {
        let options = model.journeyOptions.isEmpty ? model.journey.map { [$0] } ?? [] : model.journeyOptions
        let differentDays = Set(options.map { Calendar.current.startOfDay(for: $0.arrival) }).count > 1
        return VStack(spacing: 8) {
            ForEach(options) { option in
                let comparison = CyclingComparison.excess(option, limit: model.resultCyclingLimit) > 0
                let selected = option.id == model.journey?.id
                Button { model.selectJourney(id: option.id) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if comparison { Image(systemName: "bicycle").accessibilityHidden(true) }
                            Text("Ankunft \(option.arrival.formatted(date: differentDays ? .abbreviated : .omitted, time: .shortened)) · \(option.duration.formattedDuration)")
                                .font(.subheadline.weight(.semibold))
                        }
                        Text(JourneyEffort(option).label).font(.caption)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(selected ? FoldRouteColor.signalYellow : .white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(selected ? FoldRouteColor.asphalt : .white)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(optionTitle(option)). Ankunft \(option.arrival.formatted(date: .abbreviated, time: .shortened)), Gesamtdauer \(option.duration.formattedDuration). \(JourneyEffort(option).label)")
                .accessibilityAddTraits(selected ? [.isSelected] : [])
                .accessibilityIdentifier("journeyChoice-\(option.id)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Verbindung auswählen")
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

    @ViewBuilder
    private var planningActions: some View {
        Button {
            if model.isReplanningAfterNavigation { model.retryPlanningAfterNavigation() }
            else if model.isPreviewReplan { model.retryPreviewPlanning() }
            else { model.refreshPlannedRoutes() }
        } label: {
            Text(model.isPreviewReplan || model.isReplanningAfterNavigation ? "Wiederholen" : "Aktualisieren")
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .disabled(model.planningRequestsPaused || model.planningState.isLoading || model.navigationStartState.isLoading)
        .accessibilityIdentifier("refreshPlannedRoutes")
        Button { showsAdjustments = true } label: {
            Text("Route anpassen").fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
            .disabled(model.planningState.isLoading || model.navigationStartState.isLoading)
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

private struct FoldLine: View {
    let legs: [JourneyLeg]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(legs.enumerated()), id: \.element.id) { index, leg in
                HStack(spacing: 0) {
                    if index > 0 {
                        Rectangle()
                            .fill(leg.kind.color.opacity(0.72))
                            .frame(height: 3)
                    }
                    Image(systemName: leg.kind.symbol)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(FoldRouteColor.asphalt)
                        .frame(width: 28, height: 28)
                        .background(leg.kind.color, in: leg.kind == .fold || leg.kind == .unfold ? AnyShape(DiamondShape()) : AnyShape(Circle()))
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(legs.map(\.kind.title).joined(separator: ", "))
    }
}

private struct DiamondShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
            path.closeSubpath()
        }
    }
}

private struct JourneyLegRow: View {
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


struct JourneyTimeSummary: View {
    let journey: Journey
    @ScaledMetric(relativeTo: .title) private var timeSize = 32.0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    timeBlock("Abfahrt", date: journey.departure)
                    Image(systemName: "arrow.right")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    timeBlock("Ankunft", date: journey.arrival)
                }
                VStack(alignment: .leading, spacing: 12) {
                    timeBlock("Abfahrt", date: journey.departure)
                    timeBlock("Ankunft", date: journey.arrival)
                }
            }
            Text(journey.duration.formattedDuration)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.68))
                .accessibilityLabel("Gesamtdauer \(journey.duration.formattedDuration)")
        }
        .accessibilityElement(children: .contain)
    }

    private func timeBlock(_ title: String, date: Date) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.68))
            Text(date, format: .dateTime.hour().minute())
                .font(.system(size: timeSize, weight: .heavy, design: .rounded))
                .monospacedDigit()
            if !Calendar.current.isDateInToday(date) {
                Text(date, format: .dateTime.day().month().year())
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.68))
            }
        }
        .fixedSize(horizontal: true, vertical: true)
        .accessibilityElement(children: .combine)
    }
}
