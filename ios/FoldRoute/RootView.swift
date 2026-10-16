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
    @State private var sharedItem: PendingSharedDestination?
    @State private var deferredShare: PendingSharedDestination?
    @State private var seenShareID: UUID?
    @State private var confirmsSharedReplacement = false

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
        .onAppear { syncRouteActivity(); checkSharedDestination() }
        .safeAreaInset(edge: .top) {
            if deferredShare != nil && sharedItem == nil && !confirmsSharedReplacement {
                Button("Geteiltes Ziel") { openSharedDestination() }
                    .frame(maxWidth: .infinity, minHeight: 44).background(.bar)
            }
        }
        .sheet(item: $sharedItem) { item in
            SharedDestinationView(item: item, onSelect: { place in
                sharedItem = nil
                selectedTab = .route
                model.select(place, for: .destination)
                discardSharedDestination(item)
                Task { await model.planSharedDestination(place) }
            }, onDiscard: { discardSharedDestination(item) })
            .environment(model)
        }
        .alert("Neue Route planen?", isPresented: $confirmsSharedReplacement) {
            Button("Neue Route planen") {
                model.stopNavigation()
                sharedItem = deferredShare
            }
            Button("Navigation fortsetzen", role: .cancel) {}
        } message: {
            let parsed = deferredShare.map { SharedDestination.parse($0.payload) }
            Text("Neue Route zu \(parsed?.name ?? parsed?.query ?? "dem geteilten Ziel") planen? Die laufende Navigation wird beendet.")
        }
        .onChange(of: model.localDataRevision) { _, _ in
            deferredShare = nil; sharedItem = nil; seenShareID = nil
        }
        .onChange(of: sharedItem != nil || confirmsSharedReplacement) { _, _ in syncRouteActivity() }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .onChange(of: keepScreenAwake) { _, _ in syncRouteActivity() }
        .onChange(of: model.location.previewObscured) { _, _ in syncRouteActivity() }
        .onChange(of: selectedTab) { _, _ in syncRouteActivity() }
        .onChange(of: model.journey != nil || model.isPreviewReplan) { _, _ in syncRouteActivity() }
        .onChange(of: model.navigation != nil) { _, _ in syncRouteActivity() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive(); checkSharedDestination() }
            syncRouteActivity()
        }
    }
    private func checkSharedDestination() {
        guard let store = model.sharedDestinationStore else { return }
        do {
            guard let item = try store.read() else { deferredShare = nil; return }
            guard item.id != seenShareID else { return }
            seenShareID = item.id
            deferredShare = item
            openSharedDestination()
        } catch {
            model.dataMessage = error.localizedDescription
        }
    }

    private func openSharedDestination() {
        // Keep an open route editor intact; its pending target stays available
        // via the button after the editor closes.
        guard deferredShare != nil, !model.location.previewObscured else { return }
        if model.navigation != nil { confirmsSharedReplacement = true }
        else { sharedItem = deferredShare }
    }

    private func discardSharedDestination(_ item: PendingSharedDestination) {
        do {
            try model.sharedDestinationStore?.remove(id: item.id)
            if deferredShare?.id == item.id { deferredShare = nil }
        } catch {
            model.dataMessage = error.localizedDescription
        }
    }
    private func syncRouteActivity() {
        model.setHistoryNamesActive(scenePhase == .active)
        model.location.previewVisible = scenePhase == .active && selectedTab == .route
            && model.navigation == nil && sharedItem == nil && (model.journey != nil || model.isPreviewReplan)
        UIApplication.shared.isIdleTimerDisabled = ScreenAwakePolicy.enabled(
            preference: keepScreenAwake, foreground: scenePhase == .active,
            previewVisible: model.location.previewVisible,
            previewObscured: model.location.previewObscured || sharedItem != nil, navigating: model.navigation != nil)
    }

}
