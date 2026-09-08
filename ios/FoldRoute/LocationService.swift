import CoreLocation
import Observation

@MainActor
@Observable
final class LocationService: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    private(set) var currentLocation: CLLocation?
    private(set) var authorizationStatus: CLAuthorizationStatus
    private(set) var accuracyAuthorization: CLAccuracyAuthorization
    private(set) var lastError: Error?
    var onLocation: ((CLLocation) -> Void)?
    private var navigationRequested = false

    override init() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        super.init()
        manager.delegate = self
        manager.activityType = .fitness
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 10
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
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        guard isAuthorized else { return }
        if navigationRequested {
            beginNavigationUpdates()
        } else {
            manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        currentLocation = location
        lastError = nil
        onLocation?(location)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        lastError = error
    }
}
