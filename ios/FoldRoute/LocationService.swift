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
        status = .evaluate(authorization: authorizationStatus, servicesEnabled: servicesEnabled,
                           location: currentLocation, now: now)
        if status == .ready, lastError != nil { status = .failed }
    }

    func refreshAuthorization() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        servicesEnabled = CLLocationManager.locationServicesEnabled()
        refreshStatus()
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
        } else if isAuthorized {
            manager.requestLocation()
        }
    }

    func startNavigation() {
        navigationRequested = true
        guard isAuthorized else {
            requestAuthorization()
            return
        }
        beginNavigationUpdates()
    }

    func stopNavigation() {
        navigationRequested = false
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        manager.pausesLocationUpdatesAutomatically = true
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 10
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
        if navigationRequested {
            beginNavigationUpdates()
        } else {
            manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        currentLocation = location
        if NavigationStartPolicy.isUsable(location) { lastError = nil }
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
