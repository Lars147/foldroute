import SwiftUI

enum ScreenAwakePolicy {
    static func enabled(preference: Bool, foreground: Bool, previewVisible: Bool,
                        previewObscured: Bool, navigating: Bool) -> Bool {
        preference && foreground && (navigating || (previewVisible && !previewObscured))
    }
}

private enum RootTab: Hashable {
    case route
    case history
    case settings
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("foldroute.screenAwake") private var keepScreenAwake = true
    @State private var selectedTab: RootTab = .route

    var body: some View {
        Group {
            if model.navigation != nil {
                ActiveNavigationView()
            } else {
                TabView(selection: $selectedTab) {
                    NavigationStack {
                        PlannerView(openSettings: { selectedTab = .settings })
                    }
                    .tabItem { Label("Route", systemImage: "map") }
                    .tag(RootTab.route)

                    NavigationStack {
                        HistoryView { selectedTab = .route }
                    }
                    .tabItem { Label("Fahrten", systemImage: "clock.arrow.circlepath") }
                    .tag(RootTab.history)

                    NavigationStack {
                        SettingsView()
                    }
                    .tabItem { Label("Einstellungen", systemImage: "slider.horizontal.3") }
                    .tag(RootTab.settings)
                }
                .tint(
                    colorScheme == .dark
                        ? FoldRouteColor.signalYellow
                        : FoldRouteColor.asphalt
                )
            }
        }
        .preferredColorScheme(nil)
        .onAppear { syncRouteActivity() }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .onChange(of: keepScreenAwake) { _, _ in syncRouteActivity() }
        .onChange(of: model.location.previewObscured) { _, _ in syncRouteActivity() }
        .onChange(of: selectedTab) { _, _ in syncRouteActivity() }
        .onChange(of: model.journey != nil || model.isPreviewReplan) { _, _ in syncRouteActivity() }
        .onChange(of: model.navigation != nil) { _, _ in syncRouteActivity() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() }
            syncRouteActivity()
        }
    }
    private func syncRouteActivity() {
        model.location.previewVisible = scenePhase == .active && selectedTab == .route
            && model.navigation == nil && (model.journey != nil || model.isPreviewReplan)
        UIApplication.shared.isIdleTimerDisabled = ScreenAwakePolicy.enabled(
            preference: keepScreenAwake, foreground: scenePhase == .active,
            previewVisible: model.location.previewVisible,
            previewObscured: model.location.previewObscured, navigating: model.navigation != nil)
    }

}
