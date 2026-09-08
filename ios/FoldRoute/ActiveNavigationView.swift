import SwiftUI

struct ActiveNavigationView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmStop = false
    @State private var showAlternative = false
    @State private var stripHeight: CGFloat = 0
    @State private var panelHeight: CGFloat = 0

    var body: some View {
        if let engine = model.navigation {
            navigation(engine)
        } else {
            Color.clear
        }
    }

    private func navigation(_ engine: NavigationEngine) -> some View {
        GeometryReader { geometry in
            ZStack {
                RouteMapView(
                    journey: engine.journey,
                    highlightedLegID: engine.currentLeg?.id,
                    navigationCamera: NavigationCameraInput(
                        location: model.location.currentLocation,
                        leg: engine.currentLeg,
                        maneuver: engine.currentManeuver,
                        fallback: engine.journey.destination.coordinate
                    ),
                    cameraInsets: MapCameraInsets(
                        top: geometry.safeAreaInsets.top + stripHeight + 8,
                        bottom: geometry.safeAreaInsets.bottom + panelHeight + 8
                    )
                )
                .ignoresSafeArea()

                VStack(spacing: 12) {
                    NavigationPhaseStrip(engine: engine)
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { stripHeight = $0 }

                    Spacer()

                    Group {
                        if engine.phase == .arrived {
                            arrivalPanel
                        } else {
                            instructionPanel(engine)
                        }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { panelHeight = $0 }
                }
                .padding(.bottom, 8)
            }
        }
        .sheet(isPresented: $showAlternative) { alternativeSheet }
        .confirmationDialog("Navigation beenden?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Navigation beenden", role: .destructive) {
                model.stopNavigationAndReplan()
            }
            Button("Weiterfahren", role: .cancel) {}
        }
    }

    private func instructionPanel(_ engine: NavigationEngine) -> some View {
        ViewThatFits(in: .vertical) {
            instructionContent(engine).fixedSize(horizontal: false, vertical: true)
            ScrollView { instructionContent(engine) }
        }
        .cockpitPanel()
        .padding(.horizontal, 12)
    }

    private func instructionContent(_ engine: NavigationEngine) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let transit = engine.journey.remainingTransit(from: engine.currentLegIndex).first {
                transitStatus(transit)
            }
            if let issue = model.transitDisruption {
                Label(issue.message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(FoldRouteColor.signalYellow)
            }
            if let message = engine.statusMessage {
                Label(message, systemImage: engine.isReplanning ? "arrow.triangle.2.circlepath" : "exclamationmark.triangle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(FoldRouteColor.signalYellow)
                    .accessibilityLabel("Navigationsstatus: \(message)")
            }

            HStack(alignment: .top, spacing: 16) {
                Image(systemName: engine.currentManeuver?.direction.symbol ?? engine.currentLeg?.kind.symbol ?? "location.north")
                    .font(.system(size: 34, weight: .heavy, design: .rounded))
                    .foregroundStyle(engine.currentLeg?.kind.color ?? FoldRouteColor.signalYellow)
                    .frame(width: 52, height: 52)

                VStack(alignment: .leading, spacing: 5) {
                    if let distance = engine.distanceToNext {
                        Text(distance.formattedDistance)
                            .font(.system(size: 32, weight: .heavy, design: .rounded).monospacedDigit())
                    }
                    Text(engine.instruction)
                        .font(.title3.weight(.bold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(engine.detail)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.64))
                }
            }

            if let message = model.alternativeMessage {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
            if model.isFindingAlternative {
                ProgressView("Alternative wird gesucht …").tint(FoldRouteColor.signalYellow)
            } else if model.navigationAlternative != nil {
                Button("Alternative ansehen") { showAlternative = true }
                    .buttonStyle(.borderedProminent)
                    .tint(FoldRouteColor.signalYellow)
                    .foregroundStyle(FoldRouteColor.asphalt)
            } else if model.transitDisruption != nil || engine.journey.remainingTransit(from: engine.currentLegIndex).contains(where: { $0.reference == nil || $0.refreshFailure == .unavailable }) {
                Button("Neue Verbindung suchen") { model.proposeNavigationAlternative() }
                    .buttonStyle(.bordered)
                    .tint(FoldRouteColor.signalYellow)
            }

            HStack(spacing: 10) {
                Button {
                    engine.advance()
                } label: {
                    Label("Schritt fertig", systemImage: "checkmark")
                        .lineLimit(1)
                        .minimumScaleFactor(0.25)
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.borderedProminent)
                .tint(FoldRouteColor.signalYellow)
                .foregroundStyle(FoldRouteColor.asphalt)

                Button {
                    confirmStop = true
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 48, height: 48)
                }
                .buttonStyle(.bordered)
                .tint(.white)
                .accessibilityLabel("Navigation beenden")
            }
        }
    }

    private func transitStatus(_ leg: TransitLeg) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            let title = leg.refreshFailure == .unavailable || leg.reference == nil ? "Aktualisierung nicht verfügbar"
                : leg.refreshFailure == .network ? "Aktualisierung fehlgeschlagen"
                : !TransitRefreshPolicy.canUseTimes(leg, now: Date()) ? "Gespeicherte Daten"
                : leg.isRealtime ? "Echtzeit" : "Fahrplan"
            HStack {
                Label(title, systemImage: "clock.arrow.circlepath")
                Spacer()
                if let date = leg.lastUpdatedAt {
                    Text(date, style: .time)
                        .accessibilityLabel("Zuletzt aktualisiert um \(date.formatted(date: .omitted, time: .shortened))")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text("\(leg.line) · Abfahrt \(leg.startTime.formatted(date: .omitted, time: .shortened))\(leg.departurePlatform.map { " · Gleis \($0)" } ?? "")")
                .font(.subheadline.weight(.semibold))
            if let scheduled = leg.reference?.scheduledDeparture {
                let minutes = Int(leg.startTime.timeIntervalSince(scheduled) / 60)
                if minutes != 0 {
                    Text(minutes > 0 ? "+\(minutes) Min. Verspätung" : "\(-minutes) Min. früher")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(FoldRouteColor.signalYellow)
                }
            }
        }
    }

    private var alternativeSheet: some View {
        NavigationStack {
            ScrollView {
                if let candidate = model.navigationAlternative {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Ankunft \(candidate.journey.arrival.formatted(date: .omitted, time: .shortened))")
                            .font(.largeTitle.bold())
                        ForEach(candidate.journey.legs.dropFirst(candidate.progress.legIndex)) { leg in
                            VStack(alignment: .leading, spacing: 4) {
                                if case .transit(let transit) = leg {
                                    Text("\(transit.line) – \(transit.from.name)").font(.headline)
                                    Text("Bis \(transit.to.name)")
                                } else {
                                    Text("\(leg.kind.title) · \(leg.endPlace.name)").font(.headline)
                                }
                                Text(leg.startTime, style: .time).foregroundStyle(.secondary)
                            }
                        }
                        Button("Übernehmen") {
                            model.acceptNavigationAlternative()
                            if model.navigationAlternative == nil { showAlternative = false }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(FoldRouteColor.signalYellow)
                        .foregroundStyle(FoldRouteColor.asphalt)
                        .controlSize(.large)
                        Button("Bisherige Verbindung behalten") {
                            model.dismissNavigationAlternative()
                            showAlternative = false
                        }
                    }
                    .padding(24)
                } else {
                    Text("Die Fahrt hat sich inzwischen geändert. Bitte eine aktuelle Alternative suchen.").padding()
                }
            }
            .navigationTitle("Alternative")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var arrivalPanel: some View {
        VStack(spacing: 14) {
            Image(systemName: "flag.checkered.circle.fill")
                .font(.system(size: 50))
                .foregroundStyle(FoldRouteColor.signalYellow)
            Text("Ziel erreicht")
                .font(.system(size: 32, weight: .heavy, design: .rounded))
            Text(model.journey?.destination.name ?? "")
                .foregroundStyle(.white.opacity(0.7))
            Button("Fahrt abschließen") {
                model.stopNavigation(discardRoute: true)
            }
            .buttonStyle(.borderedProminent)
            .tint(FoldRouteColor.signalYellow)
            .foregroundStyle(FoldRouteColor.asphalt)
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .cockpitPanel()
        .padding(.horizontal, 12)
    }
}

private struct NavigationPhaseStrip: View {
    let engine: NavigationEngine

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(engine.journey.legs.enumerated()), id: \.element.id) { index, leg in
                HStack(spacing: 0) {
                    if index > 0 {
                        Rectangle()
                            .fill(index <= engine.currentLegIndex ? leg.kind.color : .white.opacity(0.2))
                            .frame(height: 3)
                    }
                    Image(systemName: leg.kind.symbol)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(index == engine.currentLegIndex ? FoldRouteColor.asphalt : .white.opacity(index < engine.currentLegIndex ? 0.85 : 0.45))
                        .frame(width: 28, height: 28)
                        .background(index == engine.currentLegIndex ? leg.kind.color : .white.opacity(0.16), in: Circle())
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(FoldRouteColor.asphalt.opacity(0.93), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Abschnitt \(engine.currentLegIndex + 1) von \(engine.journey.legs.count): \(engine.currentLeg?.kind.title ?? "")")
    }
}
