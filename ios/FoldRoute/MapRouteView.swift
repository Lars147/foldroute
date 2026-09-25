import MapKit
import SwiftUI

struct MapCameraInsets: Equatable, Sendable {
    var top: CGFloat = 0
    var leading: CGFloat = 0
    var bottom: CGFloat = 0
    var trailing: CGFloat = 0

    static let zero = MapCameraInsets()
}

enum RouteCameraFitter {
    static let minimumRouteDimension: CLLocationDistance = 1_200
    static let minimumVisibleDimension: CGFloat = 120

    static func mapRect(
        coordinates: [Coordinate],
        viewportSize: CGSize,
        insets: MapCameraInsets,
        minimumContentDimension: CLLocationDistance = minimumRouteDimension,
        minimumVisibleSize: CGFloat = minimumVisibleDimension
    ) -> MKMapRect? {
        guard !coordinates.isEmpty, viewportSize.width > 0, viewportSize.height > 0 else {
            return nil
        }

        let points = coordinates.map { MKMapPoint($0.clCoordinate) }
        guard let first = points.first else { return nil }
        let minimumX = points.dropFirst().reduce(first.x) { min($0, $1.x) }
        let maximumX = points.dropFirst().reduce(first.x) { max($0, $1.x) }
        let minimumY = points.dropFirst().reduce(first.y) { min($0, $1.y) }
        let maximumY = points.dropFirst().reduce(first.y) { max($0, $1.y) }

        let centerLatitude = coordinates.reduce(0) { $0 + $1.latitude } / Double(coordinates.count)
        let minimumMapPoints =
            minimumContentDimension / MKMetersPerMapPointAtLatitude(centerLatitude)
        let contentWidth = max(maximumX - minimumX, minimumMapPoints)
        let contentHeight = max(maximumY - minimumY, minimumMapPoints)
        let visibleWidth = max(
            minimumVisibleSize,
            viewportSize.width - insets.leading - insets.trailing
        )
        let visibleHeight = max(
            minimumVisibleSize,
            viewportSize.height - insets.top - insets.bottom
        )
        let mapPointsPerPoint = max(
            contentWidth / Double(visibleWidth),
            contentHeight / Double(visibleHeight)
        )

        let viewportMapWidth = mapPointsPerPoint * Double(viewportSize.width)
        let viewportMapHeight = mapPointsPerPoint * Double(viewportSize.height)
        let contentCenterX = (minimumX + maximumX) / 2
        let contentCenterY = (minimumY + maximumY) / 2
        let cameraCenterX =
            contentCenterX
            + Double(insets.trailing - insets.leading) * mapPointsPerPoint / 2
        let cameraCenterY =
            contentCenterY
            + Double(insets.bottom - insets.top) * mapPointsPerPoint / 2

        return MKMapRect(
            x: cameraCenterX - viewportMapWidth / 2,
            y: cameraCenterY - viewportMapHeight / 2,
            width: viewportMapWidth,
            height: viewportMapHeight
        )
    }
    static func selectedRouteRect(
        journey: Journey, viewportSize: CGSize, insets: MapCameraInsets
    ) -> MKMapRect? {
        guard viewportSize.width > insets.leading + insets.trailing,
              viewportSize.height > insets.top + insets.bottom else { return nil }
        let places = [journey.origin, journey.destination]
            + [journey.waypoint].compactMap { $0 } + journey.stops.map(\.place)
        return mapRect(
            coordinates: places.map(\.coordinate) + journey.legs.flatMap(\.coordinates),
            viewportSize: viewportSize,
            insets: insets,
            minimumVisibleSize: 1
        )
    }

}

/// Camera state belongs to a result set, independently of its selected alternative.
struct PlanningOverviewState {
    private(set) var envelope: MKMapRect?
    var isManual = false

    mutating func reset() { envelope = nil; isManual = false }

    @discardableResult
    mutating func include(_ coordinates: [Coordinate]) -> Bool {
        guard let first = coordinates.first else { return false }
        let point = MKMapPoint(first.clCoordinate)
        let bounds = coordinates.dropFirst().reduce(MKMapRect(origin: point, size: MKMapSize(width: 0, height: 0))) {
            $0.union(MKMapRect(origin: MKMapPoint($1.clCoordinate), size: MKMapSize(width: 0, height: 0)))
        }
        if let envelope, envelope.contains(bounds) { return false }
        envelope = envelope.map { $0.union(bounds) } ?? bounds
        return true
    }

    var coordinates: [Coordinate] {
        guard let envelope else { return [] }
        return [Coordinate(MKMapPoint(x: envelope.minX, y: envelope.minY).coordinate),
                Coordinate(MKMapPoint(x: envelope.maxX, y: envelope.maxY).coordinate)]
    }
}

struct RouteMapView: View {
    let journey: Journey?
    var alternativeJourneys: [Journey] = []
    var overviewID: UUID? = nil
    var planningPanelMode: String = "normal"
    var highlightedLegID: UUID?
    var navigationCamera: NavigationCameraInput? = nil
    var cameraInsets: MapCameraInsets = .zero
    var idleCenterCoordinate: Coordinate? = nil
    var planningLocationInsets: MapCameraInsets? = nil
    /// Global Y of the planning controls, supplied by the safe-area-respecting parent.
    var planningControlsTopY: CGFloat? = nil
    var onJourneySelected: ((String) -> Void)?
    var onBackgroundTapped: (() -> Void)?

    @Namespace private var mapScopeID
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var centersPlanningLocation = false {
        didSet { if !centersPlanningLocation { pendingPlanningCenter = false; planningLocationAnchor = nil } }
    }
    @State private var pendingPlanningCenter = false
    @State private var planningLocationAnchor: Coordinate?
    @State private var planningCenterError: String?
    @State private var overview = PlanningOverviewState()
    @State private var overviewInsets: MapCameraInsets?
    @State private var overviewLayout = ""
    @State private var overviewViewport = CGSize.zero
    @State private var currentOverviewRect: MKMapRect?
    @State private var navigationState = NavigationCameraState()
    @State private var navigationOffset = CGSize.zero
    @State private var anchorCorrectionsRemaining = 0

    @State private var position: MapCameraPosition = .region(
        MKCoordinateRegion(
            center: Place.munichCenter.coordinate.clCoordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.12, longitudeDelta: 0.12)
        )
    )

    var body: some View {
        GeometryReader { geometry in
            MapReader { proxy in
                Map(position: $position, scope: mapScopeID) {
                    if navigationCamera != nil {
                        UserAnnotation()
                    } else if let location = model.location.previewLocation {
                        let stale = model.location.previewQuality == .stale
                        let label = model.location.previewQuality.label
                        MapCircle(center: location.coordinate, radius: location.horizontalAccuracy)
                            .foregroundStyle((stale ? Color.gray : Color.blue).opacity(0.12))
                            .stroke((stale ? Color.gray : Color.blue).opacity(0.6), lineWidth: 1)
                        Annotation(label, coordinate: location.coordinate) {
                            Circle().fill(stale ? Color.gray : Color.blue)
                                .frame(width: 16, height: 16)
                                .overlay(Circle().stroke(.white, lineWidth: 3))
                                .shadow(radius: 2)
                                .accessibilityLabel("\(label), Genauigkeit etwa \(location.horizontalAccuracy.formatted(.number.precision(.fractionLength(0)))) Meter")
                                .accessibilityIdentifier("liveLocationMarker")
                        }
                    }

                    if let journey {
                        ForEach(backgroundJourneys) { alternative in
                            ForEach(alternative.legs) { leg in
                                if leg.coordinates.count > 1 {
                                    MapPolyline(coordinates: leg.coordinates.map(\.clCoordinate))
                                        .stroke(
                                            FoldRouteColor.cloud.opacity(0.26),
                                            style: StrokeStyle(
                                                lineWidth: 5,
                                                lineCap: .round,
                                                lineJoin: .round
                                            )
                                        )
                                        .mapOverlayLevel(level: .aboveRoads)
                                }
                            }
                        }

                        ForEach(journey.legs) { leg in
                            if leg.coordinates.count > 1 {
                                MapPolyline(coordinates: leg.coordinates.map(\.clCoordinate))
                                    .stroke(
                                        leg.kind.color.opacity(
                                            highlightedLegID == nil || highlightedLegID == leg.id
                                                ? 1 : 0.28),
                                        style: StrokeStyle(
                                            lineWidth: highlightedLegID == leg.id ? 9 : 6,
                                            lineCap: .round,
                                            lineJoin: .round,
                                            dash: leg.kind == .approach ? [10, 8] : []
                                        )
                                    )
                                    .mapOverlayLevel(level: .aboveRoads)
                            }

                            if leg.kind == .fold || leg.kind == .unfold,
                                let coordinate = leg.coordinates.first?.clCoordinate
                            {
                                Annotation(leg.kind.title, coordinate: coordinate) {
                                    Image(systemName: leg.kind.symbol)
                                        .font(.system(size: 15, weight: .bold, design: .rounded))
                                        .foregroundStyle(FoldRouteColor.asphalt)
                                        .frame(width: 34, height: 34)
                                        .background(FoldRouteColor.signalYellow, in: Diamond())
                                        .shadow(radius: 4, y: 2)
                                }
                            }
                        }

                        ForEach(Array(journey.stops.enumerated()), id: \.element.id) { index, stop in
                            Marker("\(index+1): \(stop.place.name)", coordinate: stop.place.coordinate.clCoordinate)
                                .tint(FoldRouteColor.signalYellow)
                        }
                        Marker("Start", coordinate: journey.origin.coordinate.clCoordinate)
                            .tint(FoldRouteColor.routeCyan)
                        if let waypoint = journey.waypoint {
                            Marker("Geplanter Start", coordinate: waypoint.coordinate.clCoordinate)
                                .tint(FoldRouteColor.signalYellow)
                        }
                        Marker("Ziel", coordinate: journey.destination.coordinate.clCoordinate)
                            .tint(FoldRouteColor.alertCoral)
                    }
                }
                .mapStyle(.standard(elevation: .realistic, emphasis: .muted))
                .mapControls {
                    if onBackgroundTapped == nil && navigationCamera == nil && journey == nil {
                        MapCompass()
                    }
                }
                .onChange(of: journey?.id) { _, _ in
                    if navigationCamera != nil { updateNavigationCamera(animated: true) }
                }
                .onChange(of: overviewID) { _, _ in
                    overview.reset()
                    overviewInsets = nil
                    centersPlanningLocation = false
                    updateCamera(viewportSize: geometry.size, animated: false)
                }
                .onChange(of: model.location.currentLocation) { _, _ in
                    if navigationCamera == nil, pendingPlanningCenter,
                       let location = model.location.previewLocation,
                       PreviewLocationQuality.evaluate(location) != .stale {
                        planningLocationAnchor = Coordinate(location.coordinate)
                        pendingPlanningCenter = false
                        updateCamera(viewportSize: geometry.size, animated: true)
                    }
                }
                .task(id: "\(pendingPlanningCenter)-\(model.location.isAuthorized)") {
                    guard pendingPlanningCenter, model.location.isAuthorized else { return }
                    do { try await Task.sleep(for: .seconds(12)) } catch { return }
                    guard pendingPlanningCenter else { return }
                    pendingPlanningCenter = false
                    planningCenterError = model.location.status.message ?? "Standortabfrage dauert zu lange. Bitte erneut versuchen."
                }
                .onChange(of: model.location.status) { _, status in
                    if pendingPlanningCenter, [.denied, .restricted, .disabled, .failed].contains(status) {
                        pendingPlanningCenter = false
                        planningCenterError = status.message
                    }
                }
                .onChange(of: model.location.previewVisible && !model.location.previewObscured) { _, visible in
                    if !visible { pendingPlanningCenter = false }
                }
                .alert("Standort nicht verfügbar", isPresented: Binding(get: { planningCenterError != nil }, set: { if !$0 { planningCenterError = nil } })) {
                    Button("OK", role: .cancel) { planningCenterError = nil }
                } message: { Text(planningCenterError ?? "") }
                .onChange(of: overviewCoordinates) { _, _ in
                    updateCamera(viewportSize: geometry.size, animated: true)
                }
                .task(id: planningPanelMode) {
                    await Task.yield()
                    if !Task.isCancelled { updateCamera(viewportSize: geometry.size, animated: false) }
                }
                .task(id: cameraInsets) {
                    if navigationCamera != nil {
                        updateNavigationCamera(animated: false)
                        await Task.yield()
                        if !Task.isCancelled, let camera = position.camera {
                            correctNavigationAnchor(camera: camera, proxy: proxy, viewport: geometry.size)
                        }
                        return
                    }
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    if journey == nil {
                        updateIdleCamera(viewportSize: geometry.size)
                    } else {
                        updateCamera(viewportSize: geometry.size, animated: false)
                    }
                }
                .task(id: planningLocationInsets) {
                    await Task.yield()
                    guard !Task.isCancelled, navigationCamera == nil, centersPlanningLocation else { return }
                    updateCamera(viewportSize: geometry.size, animated: false)
                }
                .task(id: idleCenterCoordinate) {
                    await Task.yield()
                    guard !Task.isCancelled, journey == nil else { return }
                    updateIdleCamera(viewportSize: geometry.size)
                }
                .task(id: geometry.size) {
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    if journey == nil {
                        updateIdleCamera(viewportSize: geometry.size)
                    } else {
                        updateCamera(viewportSize: geometry.size, animated: false)
                        if let camera = position.camera {
                            correctNavigationAnchor(camera: camera, proxy: proxy, viewport: geometry.size)
                        }
                    }
                }
                .onChange(of: navigationCamera) { _, _ in
                    updateNavigationCamera(animated: true)
                }
                .onChange(of: position.positionedByUser) { _, byUser in
                    if byUser { centersPlanningLocation = false; overview.isManual = true }
                    if byUser && navigationCamera != nil {
                        navigationState.pause()
                        anchorCorrectionsRemaining = 0
                    }
                }
                .onMapCameraChange(frequency: .onEnd) { context in
                    if navigationCamera == nil { currentOverviewRect = context.rect }
                    correctNavigationAnchor(camera: context.camera, proxy: proxy, viewport: geometry.size)
                }
                .simultaneousGesture(
                    SpatialTapGesture()
                        .onEnded { value in
                            selectJourney(at: value.location, using: proxy)
                        }
                )
                .overlay(alignment: .topTrailing) {
                    if navigationCamera != nil {
                        VStack(spacing: 12) {
                            MapCompass(scope: mapScopeID)
                                .simultaneousGesture(TapGesture().onEnded {
                                    navigationState.pause()
                                    anchorCorrectionsRemaining = 0
                                })
                            Button {
                                navigationState.resume()
                                updateNavigationCamera(animated: true)
                            } label: {
                                Image(systemName: navigationState.isFollowing ? "location.fill" : "location")
                                    .font(.system(size: 20, weight: .semibold))
                                    .foregroundStyle(FoldRouteColor.signalYellow)
                                    .frame(width: 44, height: 44)
                                    .background(.ultraThinMaterial, in: Circle())
                            }
                            .accessibilityLabel("Navigation zentrieren")
                            .accessibilityValue(navigationState.isFollowing ? "Standort wird verfolgt" : "Karte frei beweglich")
                        }
                        .padding(.trailing, 16)
                        .padding(.top, max(geometry.safeAreaInsets.top, cameraInsets.top) + 8)
                    } else {
                        VStack(alignment: .trailing, spacing: 12) {
                            VStack(spacing: 8) {
                                Button {
                                    centersPlanningLocation = true
                                    planningCenterError = nil
                                    if let location = model.location.previewLocation,
                                       PreviewLocationQuality.evaluate(location, failed: model.location.lastError != nil) != .stale {
                                        planningLocationAnchor = Coordinate(location.coordinate)
                                        pendingPlanningCenter = false
                                        updateCamera(viewportSize: geometry.size, animated: true)
                                    } else if !model.location.isAuthorized && model.location.authorizationStatus != .notDetermined {
                                        centersPlanningLocation = false
                                        planningCenterError = model.location.status.message
                                    } else {
                                        planningLocationAnchor = nil
                                        pendingPlanningCenter = true
                                        model.location.requestSingleUpdate()
                                    }
                                } label: {
                                    Image(systemName: centersPlanningLocation ? "location.fill" : "location")
                                        .font(.system(size: 20, weight: .semibold))
                                        .foregroundStyle(FoldRouteColor.signalYellow)
                                        .frame(width: 48, height: 48)
                                        .background(FoldRouteColor.asphalt.opacity(0.88), in: Circle())
                                        .contentShape(Circle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Aktuellen Standort anzeigen")
                                .accessibilityValue(centersPlanningLocation ? "Standort zentriert" : "Karte frei beweglich")
                                .accessibilityIdentifier("planningLocationButton")
                                if journey != nil {
                                    Button {
                                        centersPlanningLocation = false
                                        overview.reset()
                                        overviewInsets = nil
                                        updateCamera(viewportSize: geometry.size, animated: false)
                                    } label: {
                                        Image(systemName: "viewfinder")
                                            .font(.system(size: 20, weight: .semibold))
                                            .foregroundStyle(FoldRouteColor.signalYellow)
                                            .frame(width: 48, height: 48)
                                            .background(FoldRouteColor.asphalt.opacity(0.88), in: Circle())
                                            .contentShape(Circle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(overviewJourneys.count > 1 ? "Alle Routen anzeigen" : "Gesamte Route anzeigen")
                                    .accessibilityHint("Zeigt alle angebotenen Strecken im sichtbaren Kartenbereich.")
                                    .accessibilityIdentifier("planningRouteFitButton")
                                }
                            }
                            MapCompass(scope: mapScopeID)
                        }
                        .padding(.trailing, 16)
                        .padding(.top, planningControlsTopY.map {
                            max(0, $0 - geometry.frame(in: .global).minY)
                        } ?? (geometry.safeAreaInsets.top + 12))
                    }
                }
                .mapScope(mapScopeID)
            }
        }
    }

    private func updateCamera(viewportSize: CGSize, animated: Bool) {
        if navigationCamera != nil {
            updateNavigationCamera(animated: animated)
            return
        }
        if centersPlanningLocation {
            guard let anchor = planningLocationAnchor,
                  let rect = RouteCameraFitter.mapRect(
                    coordinates: [anchor],
                    viewportSize: viewportSize,
                    insets: planningLocationInsets ?? cameraInsets,
                    minimumContentDimension: 400
                  ) else { return }
            if animated && !reduceMotion {
                withAnimation(.easeInOut(duration: 0.45)) { position = .rect(rect) }
            } else {
                position = .rect(rect)
            }
            return
        }
        guard journey != nil else { return }
        let extended = overview.include(overviewCoordinates)
        let newLayout = overviewInsets == nil || overviewLayout != planningPanelMode || overviewViewport != viewportSize
        let reserved = newLayout ? cameraInsets : MapCameraInsets(
            top: max(overviewInsets?.top ?? 0, cameraInsets.top),
            leading: max(overviewInsets?.leading ?? 0, cameraInsets.leading),
            bottom: max(overviewInsets?.bottom ?? 0, cameraInsets.bottom),
            trailing: max(overviewInsets?.trailing ?? 0, cameraInsets.trailing))
        let layoutChanged = newLayout || reserved != overviewInsets
        guard !overview.isManual, extended || layoutChanged else { return }
        if !layoutChanged, let rect = currentOverviewRect, let insets = overviewInsets,
           let envelope = overview.envelope, viewportSize.width > 0, viewportSize.height > 0 {
            let scaleX = rect.width / viewportSize.width, scaleY = rect.height / viewportSize.height
            let visible = MKMapRect(x: rect.minX + insets.leading * scaleX,
                                    y: rect.minY + insets.top * scaleY,
                                    width: max(0, rect.width - (insets.leading + insets.trailing) * scaleX),
                                    height: max(0, rect.height - (insets.top + insets.bottom) * scaleY))
            if visible.contains(envelope) { return }
        }
        if layoutChanged {
            overviewInsets = reserved
            overviewLayout = planningPanelMode
            overviewViewport = viewportSize
        }
        guard let mapRect = RouteCameraFitter.mapRect(
            coordinates: overview.coordinates, viewportSize: viewportSize,
            insets: overviewInsets ?? cameraInsets
        ) else { return }
        position = .rect(mapRect)
    }

    private var overviewJourneys: [Journey] {
        var routes = alternativeJourneys
        if let journey, !routes.contains(where: { $0.id == journey.id }) { routes.append(journey) }
        return routes.sorted { $0.id < $1.id }
    }

    private var overviewCoordinates: [Coordinate] {
        overviewJourneys.flatMap { route in
            ([route.origin, route.destination] + [route.waypoint].compactMap { $0 } + route.stops.map(\.place)).map(\.coordinate)
                + route.legs.flatMap(\.coordinates)
        }
    }

    private func updateNavigationCamera(animated: Bool) {
        guard let navigationCamera else { return }
        let previous = navigationState.target
        guard let target = navigationState.update(navigationCamera) else { return }
        if let previous {
            let angle = NavigationCameraState.headingDelta(from: previous.heading, to: target.heading) * .pi / 180
            let scale = target.distance / previous.distance
            let x = navigationOffset.width, y = navigationOffset.height
            navigationOffset = CGSize(
                width: (x * cos(angle) - y * sin(angle)) * scale,
                height: (x * sin(angle) + y * cos(angle)) * scale
            )
        }
        let focus = MKMapPoint(target.coordinate.clCoordinate)
        let center = MKMapPoint(x: focus.x + navigationOffset.width, y: focus.y + navigationOffset.height)
        let camera = MapCamera(centerCoordinate: center.coordinate, distance: target.distance, heading: target.heading, pitch: 45)
        anchorCorrectionsRemaining = 3
        if animated && !reduceMotion && previous != nil {
            withAnimation(.easeInOut(duration: 0.45)) { position = .camera(camera) }
        } else {
            position = .camera(camera)
        }
    }

    /// Translate the camera on the ground plane using MapKit's actual tilted projection.
    /// A bounded correction avoids feedback loops and works with changing panel heights.
    private func correctNavigationAnchor(camera: MapCamera, proxy: MapProxy, viewport: CGSize) {
        guard navigationCamera != nil, navigationState.isFollowing,
              !position.positionedByUser, anchorCorrectionsRemaining > 0,
              let target = navigationState.target else { return }
        let anchor = NavigationCameraState.anchor(viewport: viewport, insets: cameraInsets)
        guard let screenFocus = proxy.convert(target.coordinate.clCoordinate, to: .local),
              hypot(screenFocus.x - anchor.x, screenFocus.y - anchor.y) > 2,
              let anchorCoordinate = proxy.convert(anchor, from: .local) else { return }
        anchorCorrectionsRemaining -= 1
        let focus = MKMapPoint(target.coordinate.clCoordinate)
        let groundAnchor = MKMapPoint(anchorCoordinate)
        let center = MKMapPoint(camera.centerCoordinate)
        let corrected = MKMapPoint(x: center.x + focus.x - groundAnchor.x, y: center.y + focus.y - groundAnchor.y)
        navigationOffset = CGSize(width: corrected.x - focus.x, height: corrected.y - focus.y)
        position = .camera(MapCamera(centerCoordinate: corrected.coordinate, distance: target.distance, heading: target.heading, pitch: 45))
    }

    private var backgroundJourneys: [Journey] {
        guard let journey else { return [] }
        return alternativeJourneys.filter { $0.id != journey.id }
    }

    private func selectJourney(at point: CGPoint, using proxy: MapProxy) {
        guard onJourneySelected != nil || onBackgroundTapped != nil else { return }
        if let journey {
            let places = [journey.origin, journey.destination] + [journey.waypoint].compactMap { $0 }
            let annotationCoordinates = places.map(\.coordinate) + journey.legs
                .filter { $0.kind == .fold || $0.kind == .unfold }
                .compactMap { $0.coordinates.first }
            for coordinate in annotationCoordinates {
                if let anchor = proxy.convert(coordinate.clCoordinate, to: .local),
                   CGRect(x: anchor.x - 32, y: anchor.y - 64, width: 64, height: 92).contains(point) {
                    return
                }
            }
        }
        let routes = journey.map { [$0] + backgroundJourneys } ?? alternativeJourneys
        let candidates = routes.compactMap { candidate -> (String, CGFloat)? in
            let polylines = candidate.legs.compactMap { leg -> [CGPoint]? in
                let points = leg.coordinates.compactMap {
                    proxy.convert($0.clCoordinate, to: .local)
                }
                return points.count > 1 ? points : nil
            }
            guard let distance = RoutePolylineHitTester.minimumDistance(
                from: point,
                to: polylines
            ) else { return nil }
            return (candidate.id, distance)
        }
        if let match = RoutePolylineHitTester.closestJourney(in: candidates) {
            onJourneySelected?(match)
        } else {
            onBackgroundTapped?()
        }
    }

    private func updateIdleCamera(viewportSize: CGSize) {
        guard let idleCenterCoordinate else { return }
        guard
            let mapRect = RouteCameraFitter.mapRect(
                coordinates: [idleCenterCoordinate],
                viewportSize: viewportSize,
                insets: cameraInsets,
                minimumContentDimension: 5_000
            )
        else { return }
        position = .rect(mapRect)
    }
}

enum RoutePolylineHitTester {
    static let maximumTapDistance: CGFloat = 22

    static func closestJourney(in candidates: [(String, CGFloat)]) -> String? {
        guard let match = candidates.min(by: { $0.1 < $1.1 }), match.1 <= maximumTapDistance else { return nil }
        return match.0
    }

    static func minimumDistance(from point: CGPoint, to polylines: [[CGPoint]]) -> CGFloat? {
        polylines
            .flatMap { polyline in
                zip(polyline, polyline.dropFirst()).map {
                    distance(from: point, toSegmentFrom: $0.0, to: $0.1)
                }
            }
            .min()
    }

    private static func distance(
        from point: CGPoint,
        toSegmentFrom start: CGPoint,
        to end: CGPoint
    ) -> CGFloat {
        let deltaX = end.x - start.x
        let deltaY = end.y - start.y
        let squaredLength = deltaX * deltaX + deltaY * deltaY
        guard squaredLength > 0 else {
            return hypot(point.x - start.x, point.y - start.y)
        }
        let projection = max(
            0,
            min(
                1,
                ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY)
                    / squaredLength
            )
        )
        let closest = CGPoint(
            x: start.x + projection * deltaX,
            y: start.y + projection * deltaY
        )
        return hypot(point.x - closest.x, point.y - closest.y)
    }
}

private struct Diamond: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        path.closeSubpath()
        return path
    }
}
