# Browser test ownership

Each test gets a fresh Playwright context. Shared helpers configure that context;
they never share pages, IndexedDB, localStorage, or mutable application state.

Import `test` from `./test` in every browser spec. Its context fixture replaces
speech synthesis before application scripts run, including in popups, frames,
and after reloads. Announcements remain enabled and are recorded per page in
`window.testSpeech`; no announcement reaches the operating system. Navigation's
`navProbe.spoken` and `navProbe.cancelled` expose the same recording. Keep this
mock in the test harness rather than disabling the app's audio preference.

## Planning

- `planner.spec.ts`: search lifecycle, selection, refresh, and planning errors.
- `planner-editing-ux.spec.ts`: drafts, stops, timing, and planning links.
- `planner-map-ux.spec.ts`: map, location, camera, and route geometry.
- `planner-history-ux.spec.ts`: saved routes, history, offline snapshots, and storage failures.
- `planner-fixture.ts`: deterministic API responses, location timestamps, and shared actions.

Fresh mobile calculations open the map at the first current result. `plan` keeps
that default entry visible. Tests that exercise the list use `showConnections`
explicitly; tests that need the itinerary use `openSelectedDetails`.

`openApp` installs routing preferences before the first app load, then disposes
the initialization script. Reload and deletion tests therefore read the actual
stored preferences, including an intentionally missing preference key.
`openStorageSeed` uses a blank page on the application origin to populate
IndexedDB without constructing a throwaway app instance. Reloads that are the
subject of a test remain real reloads.

Late-response checks gate the relevant response and observe the original
`PlanningSession.calculate()` promise through `trackPlanning`. They wait for
both the held response handler and the application task before asserting that
the cancelled or replaced result did not change the UI or saved route.

Map gesture checks switch from fixed Date to a running clock at the same instant
after planning: Leaflet's RAF pan animation measures duration using Date.
`expectMapSettled` observes pending frames, Leaflet animation classes, panel
animations and marker/panel geometry without stopping or finishing animations.
The persistent location warning advances 6.2 seconds with the test clock, with
timers intercepted before the application loads.

Stop-duration validation, focus, draft retention, ordering and removal run once
per browser at 393 pixels. Separate layout checks cover 320, 393 and 1280 pixels,
collapsed/expanded controls, 24-pixel text and the longest validation message
(24 hours plus one minute), including focus and reachable actions.

## Navigation

- `navigation-transit-ux.spec.ts`: timetable updates, estimated progress, rail/map synchronization, and connection changes.
- `navigation-location-ux.spec.ts`: permission, timeout, external overlay return, and fresh location recovery.
- `navigation-sections-ux.spec.ts`: section selection, keyboard navigation, and current-tab scrolling.
- `navigation-recovery-ux.spec.ts`: confirmation, reload/resume, completion, and storage recovery.
- `navigation-ux.spec.ts`: guidance, camera, responsive controls, and credits.
- `navigation-layout-ux.spec.ts`: prepared departure, onboard, and missing-GPS states at 320, 390, 844 × 390, and 1280 pixels; compact rail motion.

The long station rail, collapsed-context, and GPS-estimation scenarios run at
390 pixels in **both Chromium and WebKit**. They retain the GPS/session/map/store
integration checks. Layout tests mount the real `NavigationView` with a prepared
session instead of repeating the entire ride at every viewport. Both compact and
desktop station lists, 200% text, dark appearance, and reduced motion remain covered.

The GPS badge's full loss/recovery flow and unchanged-DOM check run once per
browser at 390 pixels in dark appearance. Its layout matrix prepares the real
session with `updateLocation`, covering inaccurate and missing fixes, estimated
train positions, preparation sections and recovery at 320, 390 and 1280 pixels
in both appearances. It does not start a session timer or request location.

The timeline, turn geometry, interpolation, and progress boundary cases belong to
the existing `navigation-estimate.test.ts`, `navigation-cues.test.ts`, and
`navigation.test.ts` unit suites. Browser assertions check their connection to
the rendered UI, speech, map, and persisted progress.

Use `clock.runFor` when intermediate animation frames or repeated timer callbacks
are part of the assertion. Use `clock.fastForward` for idle periods where only
the state after the jump matters; it fires due timers at most once. Neither
method replaces actual reload, permission, history, or service-worker checks.

## Settings and regressions

`settings-ux.spec.ts` owns invalid values blocking Done, Route, History, and
browser Back, revealing hidden fields, focusing the error, and retaining the
last valid stored value. `flows-ux.spec.ts` separately checks that leaving valid
settings preserves a saved route without starting a calculation.

The recent JourneyView header geometry tests and the full browser-history header
test remain distinct: one measures geometry through animation and repeated
detail visits, the other exercises actual app/history wiring. Appearance,
touch, real basemap pixels, production build, service-worker, and offline tests
remain in their existing suites.

At 200% text, a route card can be taller than a short viewport. Each summary
part must remain reachable by scrolling, and the card must remain selectable
with the keyboard. Requiring the entire card to fit simultaneously
would reject an accessible scrollable layout on a 320 × 568 screen.
The carousel breakpoint check waits for fonts and the initial layout/resize
pass before measuring keyboard-driven scrolling; all breakpoint assertions remain.

## Verification

Run `npm test`, `npm run build`, and `npm run test:browser` from `web/`.
All split suite names retain `ux` so the existing WebKit project and CI sharding
continue to discover them. Retry, timeout, and deployment settings remain unchanged;
production checks are additionally included in the WebKit project.

For a focused performance comparison, run the three station scenarios plus
`navigation-layout-ux.spec.ts`, with two workers and no retries. Compare with
the old three groups under the same machine/worker settings. Report the focused
measurement separately from the complete suite or CI wall time.

For the second optimization comparison, include GPS badge and stop-duration
tests plus the changed cancellation, delayed-response and map-gesture checks.
Include their replacement layout cases in the after measurement. Repeat the
new response/map synchronization five times per browser before the complete run.

## Component ownership and test types

`npm run check` includes the strict test TypeScript project. Browser `/src/`
imports resolve to the same source modules Vite serves; Node helpers have an
explicit Node type context. Fixture corrections must preserve runtime assertions.

`location-probe.ts` supplies isolated typed navigation and live-location probes.
The navigation mode automatically publishes the initial watch fix and supports
quick lookups; live-location mode waits for explicit measurements and rejects
unexpected low-accuracy origin lookups. Refresh silence and cached timestamps
remain explicit controls. Both modes share watch cleanup and visibility events.

`responsive-ownership-ux.spec.ts` covers 899/900-pixel transitions with both motion
preferences: input identity and selection, sheet history and unaccepted previews,
and countdown/trip continuity. `component-lifecycle-ux.spec.ts` mounts the real
Svelte map-style picker in a dedicated component document, without replacing the
application entrypoint. It verifies repeated mount/dispose and native popover
focus behavior. `production.spec.ts` is explicitly discovered by both Chromium
and WebKit so production-path and offline contracts are not Chromium-only.

Production provider responses are mocked at the application's fetch boundary:
WebKit can bypass both page and context routing after a service worker takes
control. Only Transitous responses use recorded fixtures; an offline provider
request fails. Service-worker downloads, shell assets, cache reads, activation,
and offline reloads remain native. Tests that need different routing responses
pass their recording explicitly to the production fixture instead of depending
on a page route that a worker can bypass.

`search-lifecycle-ux.spec.ts` mounts native input, suggestions and status elements
with the real `PlaceSearch`, `PlaceBook` and `ApiClient`. A gated HTTP response
checks that disposal prevents late UI changes. Repeated mounting counts actual
public subscription deliveries during IndexedDB favorite writes and HTTP 429
pauses: exactly one active subscriber and none after disposal. No application
startup or dataset flags stand in for the component's behavior.

Prepared JourneyView/NavigationView fixtures keep the real Bootstrap-mounted
AppRoot and replace only `startApplication` with a no-op initializer. Their views
reuse the installed presentation; they must not create a second navigation root.
Startup-gate fixtures return their pending promise from `startApplication`, so
they continue to test actual Bootstrap readiness rather than bypassing it.
