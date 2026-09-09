import SwiftUI

struct JourneyPreviewView: View {
    var openSettings: () -> Void = {}
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var panel: JourneyPanelState
    @State private var lastHandleDrag = Date.distantPast
    @GestureState private var dragOffset: CGFloat = 0
    @State private var cameraPanelHeight: CGFloat = 0
    @ScaledMetric(relativeTo: .title) private var summaryTimeSize = 32.0
    @State private var summaryHeight: CGFloat = 110
    @State private var compactIssueHeight: CGFloat = 0
    @State private var compactHintHeight: CGFloat = 44
    @State private var actionsHeight: CGFloat = 170
    @State private var showsAdjustments = false

    var body: some View {
        if let journey = model.journey {
            if model.isReplanningAfterNavigation {
                returnPlanningPreview(journey: journey)
            } else {
                preview(journey: journey)
            }
        }
    }

    private func returnPlanningPreview(journey: Journey) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                RouteMapView(
                    journey: journey,
                    cameraInsets: MapCameraInsets(top: 64, leading: 24, bottom: cameraPanelHeight + 16, trailing: 24)
                )
                .ignoresSafeArea(edges: .top)
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Neue Routen").font(.headline)
                        Spacer()
                        Button { model.discardRoute() } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Route schließen")
                    }
                    Text("Nach \(model.destination?.name ?? journey.destination.name)")
                        .font(.subheadline)
                    if case .failed(let message) = model.planningState {
                        Label(model.planningFailureMessage(message), systemImage: "exclamationmark.triangle")
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Erneut versuchen") { model.retryPlanningAfterNavigation() }
                            .disabled(model.planningRequestsPaused)
                            .buttonStyle(.borderedProminent)
                            .tint(FoldRouteColor.signalYellow)
                            .foregroundStyle(FoldRouteColor.asphalt)
                        Button(model.origin == nil ? "Start wählen" : "Route anpassen") { showsAdjustments = true }
                            .buttonStyle(.bordered)
                    } else {
                        ProgressView(model.planningState == .locating ? "Standort wird ermittelt …" : "Routen werden neu berechnet …")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .cockpitPanel()
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cameraPanelHeight = $0 }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showsAdjustments) { RouteAdjustmentView(model: model) }
    }

    private func preview(journey: Journey) -> some View {
        let journeys = model.journeyOptions.isEmpty ? [journey] : model.journeyOptions
        let selection = Binding(
            get: { model.selectedJourneyIndex },
            set: { model.selectJourney(at: $0) }
        )

        return GeometryReader { geometry in
            let compactStartBelow = dynamicTypeSize.isAccessibilitySize
                || geometry.size.width - 56 - 124 < summaryTimeSize * 3.5
            let heights = JourneyPanelHeights(
                available: geometry.size.height - 8,
                summary: summaryHeight + (panel.size == .collapsed && compactStartBelow ? 92 : 0) + (panel.size == .collapsed && model.planningNotice != nil ? compactIssueHeight + 12 : 0) + (panel.size == .collapsed && model.lateDepartureDelay(for: journey) != nil ? compactHintHeight + 12 : 0),
                actions: actionsHeight,
                hasAlternatives: journeys.count > 1,
                topClearance: 72
            )
            let compact = panel.size == .collapsed
            let height = min(heights.expanded, max(heights.collapsed, heights[panel.size] - dragOffset))
            ZStack(alignment: .bottom) {
                RouteMapView(
                    journey: journey,
                    alternativeJourneys: journeys,
                    cameraInsets: MapCameraInsets(
                        top: max(64, geometry.safeAreaInsets.top + 16),
                        leading: 24,
                        bottom: cameraPanelHeight + 16,
                        trailing: 24
                    ),
                    planningLocationInsets: MapCameraInsets(
                        top: max(64, geometry.safeAreaInsets.top + 16),
                        leading: 24,
                        bottom: height + 16,
                        trailing: 24
                    ),
                    planningControlsTopY: geometry.frame(in: .global).minY + 12,
                    onJourneySelected: { journeyID in
                        guard
                            let index = journeys.firstIndex(where: { $0.id == journeyID })
                        else { return }
                        withAnimation(.easeInOut(duration: 0.25)) {
                            selection.wrappedValue = index
                        }
                    },
                    onBackgroundTapped: { changePanel(to: .collapsed) }
                )
                .ignoresSafeArea(edges: .top)

                VStack(alignment: .leading, spacing: 12) {
                    panelHandle(heights: heights)
                        .padding(.bottom, -24)
                    ZStack(alignment: compact ? .trailing : .topTrailing) {
                        JourneyOptionsPager(
                            journeys: journeys,
                            cyclingLimit: model.settings.maxCyclingMinutes,
                            searchComplete: model.bikeTransferSearchStatus != .searching,
                            selection: selection,
                            compact: compact,
                            compactStartBelow: compactStartBelow,
                            scrollsSummary: dynamicTypeSize.isAccessibilitySize || heights.expanded < summaryHeight + actionsHeight + 250
                        )
                        .frame(minHeight: compact ? 120 : nil)

                        if compact {
                            if !compactStartBelow { compactStartButton(fullWidth: false) }
                        } else {
                            Button {
                                model.discardRoute()
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 20, weight: .semibold))
                                    .frame(width: 44, height: 44)
                                    .background(.white.opacity(0.22), in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Route schließen")
                        }
                    }

                    if compact && compactStartBelow { compactStartButton(fullWidth: true) }

                    if compact, model.lateDepartureDelay(for: journey) != nil {
                        Button { changePanel(to: .normal) } label: {
                            Text("Später Start · \(lateDepartureTime(journey.departure))")
                                .font(.caption)
                                .foregroundStyle(FoldRouteColor.signalYellow)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Öffnet den vollständigen Hinweis")
                        .accessibilityIdentifier("compactLateDepartureNotice")
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { compactHintHeight = $0 }
                    }

                    if compact, let notice = model.planningNotice {
                        PlanningNoticeText(text: notice, maximumHeight: geometry.size.height * 0.35)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { compactIssueHeight = $0 }
                    }
                    if journeys.count > 1 {
                        JourneyPageIndicator(
                            pageCount: journeys.count,
                            selection: selection
                        )
                    }

                    VStack(spacing: 12) {
                        if let delay = model.lateDepartureDelay(for: journey), !compact {
                            VStack(alignment: .leading, spacing: 8) {
                                Label("Start erst \(lateDepartureTime(journey.departure)) – \(delay.formattedDuration) nach dem gewünschten Beginn. Größere Suchgrenzen können frühere Verbindungen ermöglichen.", systemImage: "clock.badge.exclamationmark")
                                    .font(.caption)
                                    .foregroundStyle(FoldRouteColor.signalYellow)
                                    .fixedSize(horizontal: false, vertical: true)
                                Button("Einstellungen anpassen", action: openSettings)
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .accessibilityIdentifier("lateDepartureNotice")
                        }
                        if model.bikeTransferSearchStatus == .searching {
                            ProgressView("Weitere Verbindungen werden geprüft …")
                                .font(.caption)
                        }
                        if let notice = model.planningNotice {
                            PlanningNoticeText(text: notice, maximumHeight: geometry.size.height * 0.22)
                        }
                        Group {
                            if dynamicTypeSize.isAccessibilitySize {
                                VStack(spacing: 4) { planningActions }
                            } else {
                                HStack(spacing: 12) { planningActions }
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(model.navigationStartState.isLoading || model.planningState.isLoading)

                        Button {
                            Task { await model.startNavigation() }
                        } label: {
                            Label(startButtonTitle, systemImage: "location.north.fill")
                                .font(.headline)
                                .lineLimit(1)
                                .minimumScaleFactor(0.5)
                                .frame(maxWidth: .infinity, minHeight: 54)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(FoldRouteColor.signalYellow)
                        .foregroundStyle(FoldRouteColor.asphalt)
                        .disabled(model.navigationStartState.isLoading)

                        if case .failed(let message) = model.navigationStartState {
                            Label(message, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(FoldRouteColor.signalYellow)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .background {
                        GeometryReader { proxy in
                            Color.clear.preference(key: PanelActionsHeightKey.self, value: proxy.size.height)
                        }
                    }
                    .frame(height: compact ? 0 : nil)
                    .clipped()
                    .opacity(compact ? 0 : 1)
                    .accessibilityHidden(compact)
                    .allowsHitTesting(!compact)
                }
                .frame(height: max(0, height - 36), alignment: .top)
                .cockpitPanel()
                .clipped()
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            .onChange(of: heights[panel.size], initial: true) { _, height in
                if panel.size != .expanded {
                    cameraPanelHeight = height
                } else if cameraPanelHeight == 0 {
                    // A refreshed preview can first appear with its panel already expanded.
                    cameraPanelHeight = heights.normal
                }
            }
        }
        .onPreferenceChange(PanelSummaryHeightKey.self) { summaryHeight = $0 }
        .onPreferenceChange(PanelActionsHeightKey.self) { actionsHeight = $0 }
        .onChange(of: model.navigationStartState) { _, state in
            if case .failed = state, panel.size == .collapsed { changePanel(to: .normal) }
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showsAdjustments) {
            RouteAdjustmentView(model: model)
        }
        .alert(
            "Startpunkt zu weit entfernt",
            isPresented: distantStartBinding,
            presenting: distantStartDistance
        ) { _ in
            Button("Route ab hier planen") {
                Task { await model.replanFromCurrentLocation() }
            }
            Button("Abbrechen", role: .cancel) {
                model.cancelNavigationPreparation()
            }
        } message: { distance in
            Text("Der geplante Start liegt \(distance.formattedDistance) von deinem Standort entfernt.")
        }
    }

    @ViewBuilder
    private func compactStartButton(fullWidth: Bool) -> some View {
        Button {
            Task { await model.startNavigation() }
        } label: {
            Group {
                if model.navigationStartState.isLoading {
                    ProgressView().tint(FoldRouteColor.asphalt)
                } else {
                    Text("Los").font(.system(size: 22, weight: .bold, design: .rounded))
                }
            }
            .foregroundStyle(FoldRouteColor.asphalt)
            .frame(width: fullWidth ? nil : 112, height: 80)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(FoldRouteColor.signalYellow, in: RoundedRectangle(cornerRadius: 24))
        }
        .buttonStyle(.plain)
        .disabled(model.navigationStartState.isLoading || model.planningState.isLoading)
        .accessibilityLabel(startButtonTitle)
        .accessibilityIdentifier("compactStartNavigation")
    }

    @ViewBuilder
    private var planningActions: some View {
        Button {
            if model.isPreviewReplan { model.retryPreviewPlanning() }
            else { model.refreshPlannedRoutes() }
        } label: {
            Label("Aktualisieren", systemImage: "arrow.clockwise")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .disabled(model.planningRequestsPaused)
        .accessibilityIdentifier("refreshPlannedRoutes")
        Button { showsAdjustments = true } label: {
            Label("Route anpassen", systemImage: "slider.horizontal.3")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
    }

    private func changePanel(to size: JourneyPanelSize) {
        withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.88)) {
            panel.set(size)
        }
    }

    private func panelHandle(heights: JourneyPanelHeights) -> some View {
        Button {
            guard Date().timeIntervalSince(lastHandleDrag) > 0.35 else { return }
            changePanel(to: panel.size == .collapsed ? panel.lastOpenSize : .collapsed)
        } label: {
            Capsule()
                .fill(.white.opacity(0.45))
                .frame(width: 72, height: 5)
                .frame(maxWidth: .infinity)
                .frame(height: 44, alignment: .top)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .offset(y: -10)
        .accessibilityLabel("Routenübersicht")
        .accessibilityValue(panel.size.title)
        .accessibilityHint("Antippen klappt die Übersicht ein oder aus. Nach oben oder unten ziehen ändert die Größe.")
        .accessibilityIdentifier("journeyPanelHandle")
        .accessibilityAction(named: "Minimieren") { changePanel(to: .collapsed) }
        .accessibilityAction(named: "Normale Größe") { changePanel(to: .normal) }
        .accessibilityAction(named: "Maximieren") { changePanel(to: .expanded) }
        .highPriorityGesture(
            DragGesture(minimumDistance: 10, coordinateSpace: .global)
                .updating($dragOffset) { value, state, _ in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    state = value.translation.height
                }
                .onChanged { value in
                    if abs(value.translation.height) > abs(value.translation.width) { lastHandleDrag = Date() }
                }
                .onEnded { value in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    lastHandleDrag = Date()
                    changePanel(to: heights.nearest(to: heights[panel.size] - value.predictedEndTranslation.height))
                }
        )
    }

    private var startButtonTitle: String {
        switch model.navigationStartState {
        case .locating: "Standort wird geprüft …"
        case .preparingApproach: "Route zum Start wird geplant …"
        default: "Navigation starten"
        }
    }

    private var distantStartDistance: Double? {
        if case .distantStart(let distance) = model.navigationStartState { return distance }
        return nil
    }

    private var distantStartBinding: Binding<Bool> {
        Binding(
            get: { distantStartDistance != nil },
            set: { if !$0 { model.cancelNavigationPreparation() } }
        )
    }
}

private struct JourneyOptionsPager: View {
    let journeys: [Journey]
    let cyclingLimit: Int
    let searchComplete: Bool
    @Binding var selection: Int
    let compact: Bool
    let compactStartBelow: Bool
    let scrollsSummary: Bool

    var body: some View {
        TabView(selection: $selection) {
            ForEach(journeys.indices, id: \.self) { index in
                JourneyOptionDetails(
                    journey: journeys[index],
                    title: optionTitle(for: index),
                    comparison: CyclingComparison.label(journeys[index], limit: cyclingLimit),
                    onlyComparison: searchComplete && journeys.allSatisfy { CyclingComparison.excess($0, limit: cyclingLimit) > 0 },
                    compact: compact,
                    compactStartBelow: compactStartBelow,
                    scrollsSummary: scrollsSummary
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .clipped()
    }

    private func optionTitle(for index: Int) -> String {
        if CyclingComparison.excess(journeys[index], limit: cyclingLimit) > 0 { return "Fahrradvergleich" }
        return index == 0 ? "Empfohlene Verbindung" : "Alternative \(index)"
    }
}

private struct JourneyOptionDetails: View {
    let journey: Journey
    let title: String
    let comparison: String?
    let onlyComparison: Bool
    let compact: Bool
    let compactStartBelow: Bool
    let scrollsSummary: Bool

    var body: some View {
        Group {
            if compact {
                ScrollView(.vertical) { summary }
                    .scrollBounceBehavior(.basedOnSize)
            } else if scrollsSummary {
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 16) {
                        summary
                        FoldLine(legs: journey.legs)
                        legs
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: compact ? 0 : 16) {
                    summary
                    timeline
                    ScrollView(.vertical) { legs }
                        .scrollIndicators(.automatic)
                        .frame(height: compact ? 0 : nil)
                        .opacity(compact ? 0 : 1)
                        .accessibilityHidden(compact)
                        .allowsHitTesting(!compact)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(title)
                if journey.isDirect {
                    Image(systemName: "bicycle")
                    Text("Nur Fahrrad")
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(FoldRouteColor.signalYellow)
            .lineLimit(2)

            if let comparison {
                Text(comparison).font(.caption).foregroundStyle(FoldRouteColor.signalYellow)
                if onlyComparison {
                    Text("Keine Verbindung innerhalb deines Radlimits gefunden.").font(.caption)
                }
            }
            JourneyTimeSummary(journey: journey)

        }
        .padding(.trailing, compact ? (compactStartBelow ? 0 : 124) : 60)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: PanelSummaryHeightKey.self, value: proxy.size.height)
            }
        }
    }

    private var timeline: some View {
        FoldLine(legs: journey.legs)
            .frame(height: compact ? 0 : nil)
            .clipped()
            .opacity(compact ? 0 : 1)
            .accessibilityHidden(compact)
    }

    private var legs: some View {
        LazyVStack(spacing: 10) {
            ForEach(journey.legs) { leg in
                JourneyLegRow(leg: leg)
            }
        }
    }
}

private struct JourneyPageIndicator: View {
    let pageCount: Int
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 7) {
            ForEach(0..<pageCount, id: \.self) { index in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        selection = index
                    }
                } label: {
                    Capsule()
                        .fill(
                            index == selection
                                ? FoldRouteColor.signalYellow
                                : Color.white.opacity(0.28)
                        )
                        .frame(width: index == selection ? 20 : 7, height: 7)
                        .animation(.easeInOut(duration: 0.2), value: selection)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Route \(index + 1) von \(pageCount)")
                .accessibilityValue(index == selection ? "Ausgewählt" : "")
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}

private struct PanelSummaryHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
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
                    .lineLimit(1)
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
        case .transit(let value): "\(value.line) – \(value.from.name)"
        }
    }

    private var detail: String {
        switch leg {
        case .approach(let value), .bike(let value), .walk(let value): value.distance.formattedDistance
        case .fold, .unfold, .wait: leg.endTime.timeIntervalSince(leg.startTime).formattedDuration
        case .transit(let value):
            value.to.name
        }
    }
}

extension TimeInterval {
    var formattedDuration: String {
        let minutes = max(1, Int((self / 60).rounded()))
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

private struct PanelActionsHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
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

    init(available: CGFloat, summary: CGFloat, actions: CGFloat, hasAlternatives: Bool = false,
         topClearance: CGFloat = 16) {
        expanded = max(0, available - topClearance)
        collapsed = min(expanded, summary + 80 + (hasAlternatives ? 19 : 0))
        normal = min(expanded, max(available * 0.74, collapsed + actions + 100))
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


/// Long failure explanations stay readable even at accessibility text sizes.
private struct PlanningNoticeText: View {
    let text: String
    let maximumHeight: CGFloat
    @State private var contentHeight: CGFloat = 20

    var body: some View {
        ScrollView {
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .frame(height: min(contentHeight, maximumHeight))
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("planningFailureReasons")
    }
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
