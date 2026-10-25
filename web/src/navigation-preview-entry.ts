import "./style.css";
import { NavigationView } from "./navigation-ui";
import { NavigationEngine, navigationJourney } from "./navigation-engine";
import { NavigationSession } from "./navigation-session";
import { ApiClient } from "./transitous";
import { defaults, type Journey, type Place, type TransitStop } from "./model";
import { transitStopKey } from "./transit-stops";
import { transitDisruption } from "./transit-refresh";

// Dev-only scene: exercise the real view without GPS, routing or persisted trips.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";
const state = params.get("state") ?? "onboard";
const boarding = state === "boarding-cancelled";
const cancellationReason =
  state === "scroll-warning"
    ? "trip"
    : boarding
      ? "boarding"
      : state === "scroll-exit-cancelled"
        ? "alighting"
        : undefined;
const warning = cancellationReason !== undefined;
const riding = state === "scroll-ride" || (warning && !boarding);
const longTrip = state === "scroll" || riding;
const rideStopIndex = 20;
const rideFraction = 0.5;
const now = Date.now() / 1000;
// Align the simulated timetable with a position halfway to the next test stop.
const start = boarding
  ? now + 300
  : now - (riding ? rideStopIndex * 120 + 90 + rideFraction * 90 : 60);
const baseNames = [
  ["Ostbahnhof", 48.1278, 11.6047],
  ["Rosenheimer Platz", 48.1285, 11.5944],
  ["Isartor", 48.1331, 11.5828],
  ["Marienplatz", 48.1371, 11.5754],
  ["Karlsplatz", 48.139, 11.5655],
  ["Hauptbahnhof", 48.1411, 11.5584],
  ["Hackerbrücke", 48.1418, 11.5489],
  ["Donnersbergerbrücke", 48.1435, 11.5355],
  ["Hirschgarten", 48.1448, 11.5178],
  ["Laim", 48.1445, 11.5028],
  ["Pasing", 48.1498, 11.4619],
] as const;
type PreviewStop = readonly [string, number, number];
const names: readonly PreviewStop[] = longTrip
  ? baseNames.flatMap((stop, i): PreviewStop[] => {
      const next = baseNames[i + 1];
      if (!next) return [stop];
      return [
        stop,
        ...Array.from({ length: 3 }, (_, j): PreviewStop => {
          const fraction = (j + 1) / 4;
          return [
            `Testhalt ${String(i * 3 + j + 1).padStart(2, "0")}`,
            stop[1] + (next[1] - stop[1]) * fraction,
            stop[2] + (next[2] - stop[2]) * fraction,
          ];
        }),
      ];
    })
  : baseNames;
const stops: TransitStop[] = names.map(([name, latitude, longitude], i) => ({
  name,
  latitude,
  longitude,
  detail: "",
  stopId: `preview-${i}`,
  arrival: start + i * 120 + (i ? 60 : 0),
  departure: start + i * 120 + (i ? 90 : 0),
  cancelled:
    (cancellationReason === "boarding" && i === 0) ||
    (cancellationReason === "alighting" && i === names.length - 1),
}));
const place = (i: number): Place => ({ ...stops[i], detail: "" });
const origin = place(0),
  destination = place(stops.length - 1);
const end = stops.at(-1)!.arrival!;
const journey: Journey = {
  id: "local-s8-preview",
  origin,
  destination,
  departure: start - 180,
  arrival: end + 180,
  isDirect: false,
  transfers: 0,
  legs: [
    {
      kind: "fold",
      from: origin,
      to: origin,
      start: start - 180,
      end: start,
      distance: 0,
      coordinates: [origin],
    },
    {
      kind: "transit",
      mode: "SUBURBAN",
      from: origin,
      to: destination,
      start,
      end,
      distance: 11200,
      coordinates: stops,
      line: "S8",
      headsign: "Herrsching",
      platform: "11",
      arrivalPlatform: "5",
      realtime: true,
      transitStops: state === "missing" ? undefined : stops,
      transitStatus: { updatedAt: now },
    },
    {
      kind: "unfold",
      from: destination,
      to: destination,
      start: end,
      end: end + 180,
      distance: 0,
      coordinates: [destination],
    },
  ],
};
const view = new NavigationView(
  () => location.reload(),
  () => location.reload(),
  { audioEnabled: false, locationAutoRefresh: () => true },
);
const session = new NavigationSession({
  changed: () => view.render(),
  locate: async () => {
    throw new Error("Vorschau verwendet keinen Gerätestandort.");
  },
  resumeEnabled: () => false,
  statisticsEnabled: () => false,
  api: new ApiClient(),
});
const stopIndex = riding
  ? rideStopIndex
  : state === "approaching"
    ? stops.length - 2
    : state === "exit"
      ? stops.length - 1
      : 0;
session.engine = new NavigationEngine(navigationJourney(journey), {
  legIndex: boarding ? 0 : 1,
  maneuverIndex: 0,
  meters: 0,
  confirmedStops: [],
  transitStop: transitStopKey(stops, stopIndex),
  // Riding scenes start between stops with departure already confirmed.
  transitDepartedStop: riding ? transitStopKey(stops, stopIndex) : undefined,
});
session.settings = defaults;
session.request = { origin, destination, timing: "now", time: start };
const previous = stops[stopIndex],
  next = stops[Math.min(stopIndex + 1, stops.length - 1)];
const position = riding
  ? {
      latitude:
        previous.latitude + (next.latitude - previous.latitude) * rideFraction,
      longitude:
        previous.longitude +
        (next.longitude - previous.longitude) * rideFraction,
    }
  : previous;
const updateLocation = () => {
  if (state !== "estimated") {
    session.updateLocation(
      { ...position, accuracy: 10, timestamp: Date.now(), heading: 270 },
      "current",
    );
  }
  session.engine!.journey.legs[1].transitStatus = {
    updatedAt: Date.now() / 1000,
    ...(warning ? { cancelled: true, cancellationReason } : {}),
  };
  session.disruption = transitDisruption(
    session.engine!.journey,
    session.engine!.progress.legIndex,
    Date.now() / 1000,
  );
  view.render();
};
updateLocation();
await view.show(session);
if (longTrip) document.getElementById("navigation-details-toggle")!.click();
setInterval(updateLocation, 1000);
