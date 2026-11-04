# PWA architecture and migration

The target is Svelte 5 with Vite, preserving existing interactions, layout, routing rules and stored data. The native application and landing page are outside this migration. The public example continues to share journey presentation without initializing personal data or location services.

## Boundaries

- Pure domain modules contain models, geometry, routing contracts, snapshot validation, navigation summaries/projections, the clock contract and update policy. They must not import presentation, browser adapters or framework code.
- Application sessions own confirmed planning/navigation state. Views issue explicit commands. A render must not mutate an engine.
- Provider, storage, GPS, service-worker and map adapters own external effects. Existing generations, cancellation guards, deletion epochs and atomic transactions remain authoritative.
- AppRoot and ExampleRoot compose feature components directly. Svelte owns their structure; application controllers pass presentation values and commands. Adapter-owned hosts (maps, search results and station timing) are explicit boundaries. Controllers must not reparent component-owned nodes.
- Maps own their host's children and must not be recreated by responsive layout changes or location updates.

`npm run check` verifies the domain import boundary and runtime import graph, Svelte/TypeScript application diagnostics, and the separate strict test project. Type-only imports do not create runtime cycles.

## DOM ownership

| Owner | Children and transitions |
| --- | --- |
| RouteEditor | One persistent destination input, suggestion list and search status; layout changes retain value, caret and focus. |
| JourneyWorkspace | Desktop results and mobile sheets share selection and scroll state. Crossing to desktop closes the sheet, consumes its overlay history entry and focuses the selected route; a preview is never accepted implicitly. |
| NavigationScreen | Guidance, section selection and actions use stable components. Countdown deadlines and the navigation session outlive responsive layout changes. |
| MapHost | Stable outer container; map adapter owns descendants. |
| SettingsScreen | Shared validated numeric fields and mode groups; SettingsController owns persisted routing preferences. |
| AppRoot / ExampleRoot | Feature composition and presentation handles. Bootstrap mounts the root before application initialization. Global toast snippets render after the app tabs to preserve keyboard order. The example does not initialize personal routing or location services. |

Prefer a stable CSS layout. Where native modal and inline presentations require separate trees, only Svelte controls the transition; selection, scroll positions and focus destinations are explicit application/view state. Countdown presentation uses an absolute deadline, so changing placement cannot restart it. Structure subscribers rebind measurements after a component changes placement.

## Implemented slices

- Strict application and test type checking, typed shared GPS/visibility harness, production test discovery in both browser projects.
- Shared snapshot payload codecs with separate history/navigation envelopes. IndexedDB statistic reset lives in the persistence adapter.
- Provider-neutral routing contracts, section-planner injection removing planner/via runtime cycle, injectable planning time/location/network dependencies.
- Svelte map-style picker, numeric settings fields, settings/mode groups, history rows, route choices/summary and shared journey detail/step/transit-time components.
- SettingsController and ShareImportController own their states and actions; the route editor owns search/draft/time/stop behavior and a stable Svelte form.
- NavigationScreen composes typed section tabs, location status, completion controls and finish summary. Map/station/timing adapters have explicit lifecycle boundaries.
- Journey rendering has explicit live/example/navigation presentation inputs and disposal; navigation no longer patches foreign detail markup.
- Deadline-based countdown presentation for the app toast; navigation pause/cancel commands go through NavigationSession.
- Pure projection mechanics and route-planning/composition service; display evidence remains separate from confirmed progress.
- An injectable millisecond clock shared by the navigation session, engine and route planner; freshness and deadlines use the same time source.
- Pure PWA update presentation/blocking policy and abortable service-worker/UI adapter lifecycle.
- Native AppRoot/ExampleRoot composition and JourneyWorkspace snippets replace production per-feature mounts and workspace DOM reparenting. Presentation handles synchronize updates where existing controllers immediately measure the DOM.

## Extension rules

Keep routing, navigation and persistence behavior in TypeScript services; add a component for reusable presentation. New UI state should use explicit typed values and actions. The constrained element-key presentation methods support the existing controllers during migration; do not expand them into a general DOM API. Isolated component fixtures may still mount a feature directly through its compatibility adapter.

The application is initialized once per document. Feature controllers expose disposal where independently mounted; root teardown clears the presentation registry. This is not an application-wide hot-remount API for all browser services.

Shared native dialog lifecycle is reused by information, time and route-action dialogs. The original stylesheet has been split into feature-oriented files in an explicit import order; their concatenated declarations remain unchanged. Component styles are bundled alongside them. Further scoping must retain this order/specificity behavior.

## Verification

The test runner and CI container both use Playwright 1.64.1. This fixes the documented WebKit 1.63 service-worker/offline navigation bug. Provider API requests are mocked at the fetch boundary in production fixtures; worker downloads, application assets and CacheStorage remain real.

Run `npm test`, `npm run check`, `npm run build`, then affected Playwright families in Chromium and WebKit. A source freeze is required during browser runs: Vite HMR can reload an active scenario and invalidate its execution context. Use the existing CI shards for the final complete browser run; retain the checked production artifact for deployment. Routing/model changes also require `npm run test:parity` without regenerating its fixture.

Responsive regression scenarios cross 899/900 px: focused input keeps its node/value/caret, desktop consumes the sheet history entry without accepting a preview, countdown keeps its deadline and completes once. Production contracts include subpath, manifest/scope, real service-worker updates and offline restart in both browsers.
