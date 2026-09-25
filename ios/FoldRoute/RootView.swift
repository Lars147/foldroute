import SwiftUI

private enum RootTab: Hashable {
    case route
    case history
    case settings
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
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
        .onAppear { syncPreviewLocation() }
        .onChange(of: selectedTab) { _, _ in syncPreviewLocation() }
        .onChange(of: model.journey != nil || model.isPreviewReplan) { _, _ in syncPreviewLocation() }
        .onChange(of: model.navigation != nil) { _, _ in syncPreviewLocation() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() }
            syncPreviewLocation()
        }
    }
    private func syncPreviewLocation() {
        model.location.previewVisible = scenePhase == .active && selectedTab == .route
            && model.navigation == nil && (model.journey != nil || model.isPreviewReplan)
    }

}
