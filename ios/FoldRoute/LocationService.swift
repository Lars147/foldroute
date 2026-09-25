import CoreLocation
import Observation

enum LocationStatus: Equatable {
    case ready, notDetermined, denied, restricted, disabled, missing, stale, inaccurate, failed

    var isUsable: Bool { self == .ready }
    var message: String? {
        switch self {
        case .ready: nil
        case .notDetermined: "Standortzugriff noch nicht erlaubt."
        case .denied: "Standortzugriff abgelehnt. In den Einstellungen erlauben."
        case .restricted: "Standortzugriff ist auf diesem Gerät eingeschränkt."
        case .disabled: "Ortungsdienste sind systemweit ausgeschaltet. In den Geräteeinstellungen einschalten."
        case .missing: "Standort fehlt. Entfernung und Position sind noch nicht verfügbar."
        case .stale: "Standort veraltet. Letzte Position und Entfernung sind nicht aktuell."
        case .inaccurate: "Standort zu ungenau. Position und Entfernung sind nur ungefähr."
        case .failed: "Standort konnte nicht aktualisiert werden. Letzte Position und Entfernung sind nicht aktuell."
        }
    }

    static func evaluate(authorization: CLAuthorizationStatus, servicesEnabled: Bool,
                         location: CLLocation?, now: Date = Date()) -> LocationStatus {
        if authorization == .restricted { return .restricted }
        if !servicesEnabled { return .disabled }
        if authorization == .notDetermined { return .notDetermined }
        if authorization == .denied { return .denied }
        guard authorization == .authorizedAlways || authorization == .authorizedWhenInUse else { return .restricted }
        guard let location else { return .missing }
        guard abs(now.timeIntervalSince(location.timestamp)) <= NavigationStartPolicy.maximumLocationAge else { return .stale }
        guard location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= NavigationStartPolicy.maximumHorizontalAccuracy else { return .inaccurate }
        return .ready
    }
}

enum LocationUpdateMode: Equatable {
    case idle, preview, navigation
    static func resolve(authorized: Bool, navigation: Bool, previewVisible: Bool, obscured: Bool) -> Self {
        guard authorized else { return .idle }
        if navigation { return .navigation }
        return previewVisible && !obscured ? .preview : .idle
    }
}

enum PreviewLocationQuality: Equatable {
    case current, inaccurate, stale
    var label: String {
        switch self {
        case .current: "Dein Standort"
        case .inaccurate: "Standort ungenau"
        case .stale: "Letzter Standort – nicht aktuell"
        }
    }
    static func evaluate(_ location: CLLocation, now: Date = Date(), failed: Bool = false) -> Self {
        if failed || abs(now.timeIntervalSince(location.timestamp)) > 60 { return .stale }
        return location.horizontalAccuracy > 100 ? .inaccurate : .current
    }
}

@MainActor
@Observable
final class LocationService: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    private(set) var currentLocation: CLLocation?
    private(set) var authorizationStatus: CLAuthorizationStatus
    private(set) var accuracyAuthorization: CLAccuracyAuthorization
    private(set) var lastError: Error?
    var onLocation: ((CLLocation) -> Void)?
    var onStatusChange: (() -> Void)?
    private(set) var status: LocationStatus = .missing
    private var servicesEnabled = true
    private var navigationRequested = false
    var previewVisible = false { didSet { reconcileUpdates() } }
    var previewObscured = false { didSet { reconcileUpdates() } }
    private(set) var updateMode: LocationUpdateMode = .idle
    private var freshnessTask: Task<Void, Never>?
    private(set) var previewQuality: PreviewLocationQuality = .stale

    var previewLocation: CLLocation? {
        guard isAuthorized, servicesEnabled, let currentLocation,
              currentLocation.horizontalAccuracy >= 0,
              CLLocationCoordinate2DIsValid(currentLocation.coordinate) else { return nil }
        return currentLocation
    }

    private func reconcileUpdates() {
        let mode = LocationUpdateMode.resolve(authorized: isAuthorized && servicesEnabled,
            navigation: navigationRequested, previewVisible: previewVisible, obscured: previewObscured)
        guard mode != updateMode else { return }
        updateMode = mode
        freshnessTask?.cancel(); freshnessTask = nil
        switch mode {
        case .navigation: beginNavigationUpdates()
        case .preview:
            manager.allowsBackgroundLocationUpdates = false
            manager.pausesLocationUpdatesAutomatically = true
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = 10
            manager.startUpdatingLocation()
            freshnessTask = Task { [weak self] in
                while !Task.isCancelled {
                    self?.refreshStatus()
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                }
            }
        case .idle:
            manager.stopUpdatingLocation()
            manager.allowsBackgroundLocationUpdates = false
            manager.pausesLocationUpdatesAutomatically = true
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = 10
        }
    }

    override init() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        super.init()
        manager.delegate = self
        manager.activityType = .fitness
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 10
        refreshAuthorization()
    }

    func refreshStatus(now: Date = Date()) {
        if let currentLocation { previewQuality = .evaluate(currentLocation, now: now, failed: lastError != nil) }
        status = .evaluate(authorization: authorizationStatus, servicesEnabled: servicesEnabled,
                           location: currentLocation, now: now)
        if status == .ready, lastError != nil { status = .failed }
    }

    func refreshAuthorization() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        servicesEnabled = CLLocationManager.locationServicesEnabled()
        refreshStatus()
        reconcileUpdates()
    }

    var isAuthorized: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    var hasPreciseLocation: Bool { accuracyAuthorization == .fullAccuracy }

    func requestAuthorization() {
        if authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    func requestSingleUpdate() {
        if authorizationStatus == .notDetermined {
            requestAuthorization()
        } else if isAuthorized && updateMode == .idle {
            manager.requestLocation()
        }
    }

    func startNavigation() {
        navigationRequested = true
        guard isAuthorized else {
            requestAuthorization()
            return
        }
        reconcileUpdates()
    }

    func stopNavigation() {
        navigationRequested = false
        reconcileUpdates()
    }

    private func beginNavigationUpdates() {
        manager.activityType = .fitness
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = 5
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        refreshAuthorization()
        onStatusChange?()
        guard isAuthorized, servicesEnabled else { return }
        reconcileUpdates()
        if updateMode == .idle { manager.requestLocation() }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last,
              location.horizontalAccuracy.isFinite, location.horizontalAccuracy >= 0,
              location.timestamp.timeIntervalSince1970.isFinite,
              CLLocationCoordinate2DIsValid(location.coordinate),
              currentLocation == nil || location.timestamp >= currentLocation!.timestamp else { return }
        currentLocation = location
        lastError = nil
        refreshStatus()
        onLocation?(location)
        onStatusChange?()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        lastError = error
        refreshStatus()
        onStatusChange?()
    }
}
