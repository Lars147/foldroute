import SwiftData
import SwiftUI

@main
struct FoldRouteApp: App {
    private let container: ModelContainer
    @State private var appModel: AppModel

    init() {
        do {
            let schema = Schema([
                StoredPlace.self,
                StoredJourney.self,
                StoredSettings.self,
                StoredActiveJourney.self
            ])
            let configuration = ModelConfiguration(
                "FoldRoute",
                schema: schema,
                isStoredInMemoryOnly: false,
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(for: schema, configurations: [configuration])
            let store = SwiftDataJourneyStore(container: container)
            let model = try AppModel(
                planner: TransitousClient(),
                store: store,
                location: LocationService(),
                guidance: GuidanceService()
            )
            self.container = container
            _appModel = State(initialValue: model)
        } catch {
            fatalError("FoldRoute storage could not start: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
        }
        .modelContainer(container)
    }
}
