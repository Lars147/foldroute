import { expect, it } from "vitest";
import { distance } from "../src/geometry";
import { navigationCues } from "../src/navigation-cues";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";
import { exampleRecording } from "../src/example-data";
import type { Coordinate, Leg, Place } from "../src/model";

const scale = (6371008.8 * Math.PI) / 180;
const point = (east: number, north = 0): Coordinate => ({
  latitude: north / scale,
  longitude: east / scale,
});
const place = (coordinate: Coordinate, name: string): Place => ({
  ...coordinate,
  name,
  detail: "",
});
const now = Date.parse("2026-10-06T10:00:00Z");
function legFor(coordinates: Coordinate[]): Leg {
  return {
    kind: "bike",
    from: place(coordinates[0], "Start"),
    to: place(coordinates.at(-1)!, "Ziel"),
    start: now / 1000,
    end: now / 1000 + 900,
    distance: coordinates
      .slice(1)
      .reduce((sum, p, i) => sum + distance(coordinates[i], p), 0),
    coordinates,
    maneuvers: coordinates.slice(1).map((p, i) => ({
      direction: "CONTINUE",
      streetName: `Straße ${i}`,
      distance: distance(coordinates[i], p),
      coordinates: [coordinates[i], p],
    })),
  };
}
function engineFor(leg: Leg) {
  return new NavigationEngine(
    navigationJourney({
      id: "guidance",
      origin: leg.from,
      destination: leg.to,
      departure: leg.start,
      arrival: leg.end,
      legs: [leg],
      transfers: 0,
      isDirect: true,
    }),
  );
}
function cuesFor(leg: Leg) {
  const path: Coordinate[] = [],
    offsets: number[] = [];
  let meters = 0;
  for (const step of leg.maneuvers ?? [])
    for (const [index, p] of step.coordinates.entries()) {
      if (path.length) meters += distance(path.at(-1)!, p);
      path.push(p);
      if (!index) offsets.push(meters);
    }
  return navigationCues(leg, path.length ? path : leg.coordinates, offsets);
}
function move(
  engine: NavigationEngine,
  coordinate: Coordinate,
  seconds: number,
) {
  const timestamp = now + seconds * 1000;
  engine.update({ ...coordinate, accuracy: 5, timestamp }, timestamp);
}

it("counts down to a real turn across short straight steps and street-name changes", () => {
  const leg = legFor([
    point(0),
    point(5),
    point(10),
    point(30),
    point(800),
    point(800, 200),
    point(1000, 200),
  ]);
  const engine = engineFor(leg);
  const key = engine.guidanceKey;
  expect(engine.instruction).toBe("Links abbiegen auf Straße 4");
  expect(engine.distanceToNext).toBeCloseTo(800);
  for (const [index, meters] of [0, 5, 10, 30, 400, 790].entries()) {
    move(engine, point(meters), index * 20);
    expect(engine.instruction).toBe("Links abbiegen auf Straße 4");
    expect(engine.distanceToNext).toBeCloseTo(800 - meters);
    expect(engine.guidanceKey).toBe(key);
  }
  move(engine, point(800), 130);
  expect(engine.instruction).toBe("Rechts abbiegen auf Straße 5");
  expect(engine.distanceToNext).toBeCloseTo(200);
  expect(engine.guidanceKey).not.toBe(key);
  move(engine, point(800, 200), 150);
  expect(engine.instruction).toBe("Mit dem Rad nach Ziel");
  expect(engine.distanceToNext).toBeCloseTo(200);
  move(engine, point(1000, 200), 170);
  expect(engine.phase).toBe("arrived");
  expect(engine.instruction).toBe("Ziel erreicht");
  expect(engine.maneuver).toBeUndefined();
});

it.each([
  [45, "LEFT"],
  [-45, "RIGHT"],
  [140, "HARD_LEFT"],
  [-140, "HARD_RIGHT"],
  [180, "UTURN_LEFT"],
])("recognizes a %s degree change as %s", (degrees, direction) => {
  const radians = (degrees * Math.PI) / 180;
  const leg = legFor([
    point(0),
    point(100),
    point(100 + 100 * Math.cos(radians), 100 * Math.sin(radians)),
  ]);
  expect(cuesFor(leg).map((cue) => cue.maneuver.direction)).toEqual([
    direction,
  ]);
});

it("ignores duplicate points, small bends and turns with less than three meters of context", () => {
  const duplicate = legFor([
    point(0),
    point(100),
    point(100),
    point(100, 200),
    point(100, 200),
  ]);
  expect(cuesFor(duplicate).map((cue) => cue.maneuver.direction)).toEqual([
    "LEFT",
  ]);
  expect(cuesFor(legFor([point(0), point(100), point(200, 20)]))).toEqual([]);
  expect(cuesFor(legFor([point(0), point(2), point(2, 100)]))).toEqual([]);
});

it("keeps nearby opposite turns while merging nearby points of one bend", () => {
  const opposite = legFor([point(0), point(100), point(100, 8), point(200, 8)]);
  expect(cuesFor(opposite).map((cue) => cue.maneuver.direction)).toEqual([
    "LEFT",
    "RIGHT",
  ]);
  const middle = point(
    100 + 6 * Math.cos((50 * Math.PI) / 180),
    6 * Math.sin((50 * Math.PI) / 180),
  );
  const sameBend = legFor([
    point(0),
    point(100),
    middle,
    point(
      middle.longitude * scale + 100 * Math.cos((110 * Math.PI) / 180),
      middle.latitude * scale + 100 * Math.sin((110 * Math.PI) / 180),
    ),
  ]);
  expect(cuesFor(sameBend)).toHaveLength(1);
  expect(cuesFor(sameBend)[0].meters).toBeCloseTo(106);
});

it.each([
  "SLIGHTLY_LEFT",
  "SLIGHTLY_RIGHT",
  "RIGHT",
  "CIRCLE_CLOCKWISE",
  "CIRCLE_COUNTERCLOCKWISE",
])("gives supplied %s guidance priority over geometry", (direction) => {
  const leg = legFor([point(0), point(100), point(100, 200)]);
  leg.maneuvers![1].direction = direction;
  const cues = cuesFor(leg);
  expect(cues).toHaveLength(1);
  expect(cues[0].maneuver).toBe(leg.maneuvers![1]);
  expect(cues[0].key).toBe("step:1");
});

it.each(["STAIRS", "ELEVATOR"])(
  "protects the whole %s section and ten meters around it",
  (direction) => {
    const coordinates = [
      point(0),
      point(100),
      point(100, 50),
      point(150, 50),
      point(150, 55),
      point(250, 55),
    ];
    const leg = legFor(coordinates);
    leg.kind = "walk";
    leg.maneuvers = [
      leg.maneuvers![0],
      {
        direction,
        streetName: "",
        distance: 100,
        coordinates: coordinates.slice(1, 4),
      },
      ...leg.maneuvers!.slice(3),
    ];
    expect(cuesFor(leg).map((cue) => cue.maneuver.direction)).toEqual([
      direction,
    ]);
  },
);

it("retains a coincident elevator anchor after filtering straight steps", () => {
  const leg = legFor([point(0), point(100), point(100, 200)]);
  leg.kind = "walk";
  leg.maneuvers!.splice(1, 0, {
    direction: "ELEVATOR",
    streetName: "",
    distance: 0,
    coordinates: [point(100)],
  });
  const engine = engineFor(leg);
  move(engine, point(100), 0);
  expect(engine.instruction).toBe("Aufzug nehmen");
  move(engine, point(100, 20), 10);
  expect(engine.instruction).toBe("Aufzug nehmen");
  move(engine, point(100, 30), 20);
  expect(engine.maneuver).toBeUndefined();
  expect(engine.instruction).toBe("Zu Fuß nach Ziel");
});

it("restores deterministic guidance without changing source geometry or snapshot indices", () => {
  const leg = legFor([point(0), point(100), point(100, 200), point(300, 200)]);
  leg.maneuvers = [
    {
      direction: "CONTINUE",
      streetName: "",
      distance: leg.distance,
      coordinates: leg.coordinates,
    },
  ];
  const original = structuredClone(leg);
  const engine = engineFor(leg);
  move(engine, point(50), 0);
  const firstKey = engine.guidanceKey;
  const progress = structuredClone(engine.progress);
  const restored = new NavigationEngine(engine.journey, progress);
  expect(restored.guidanceKey).toBe(firstKey);
  expect(restored.distanceToNext).toBeCloseTo(50);
  expect(progress.maneuverIndex).toBe(1);
  move(restored, point(100), 20);
  expect(restored.guidanceKey).not.toBe(firstKey);
  expect(restored.progress.maneuverIndex).toBe(progress.maneuverIndex);
  expect(restored.instruction).toBe("Rechts abbiegen");
  expect(leg).toEqual(original);
  expect(restored.journey.legs[0].maneuvers).toEqual(original.maneuvers);
  restored.invalidateLocation();
  expect(restored.distanceToNext).toBeUndefined();
  move(restored, point(100, 50), 21);
  expect(restored.distanceToNext).toBeCloseTo(150);
});

it("derives guidance from a path without source steps, but leaves a straight path on the destination fallback", () => {
  const leg = legFor([point(0), point(100), point(100, 200)]);
  leg.maneuvers = undefined;
  const engine = engineFor(leg);
  expect(engine.instruction).toBe("Links abbiegen");
  expect(engine.hasManeuverGuidance).toBe(true);
  const straight = legFor([point(0), point(300)]);
  straight.maneuvers = undefined;
  expect(engineFor(straight).instruction).toBe("Mit dem Rad nach Ziel");
  expect(engineFor(straight).hasManeuverGuidance).toBe(false);
});

it("finds actual turns in the recorded route whose provider supplied only CONTINUE steps", () => {
  const leg = exampleRecording.journey.legs.find(
    (leg) => leg.kind === "bike" && leg.from.name === "Unterföhring",
  )!;
  expect(leg.maneuvers!.every((step) => step.direction === "CONTINUE")).toBe(
    true,
  );
  const cues = cuesFor(leg);
  expect(cues.length).toBeGreaterThan(10);
  expect(cues[0].maneuver.direction).toBe("RIGHT");
  expect(cues[0].meters).toBeCloseTo(16.3, 0);
  expect(cues.some((cue) => cue.maneuver.direction === "LEFT")).toBe(true);
});

it("keeps a final turn active even when the destination is inside the arrival radius", () => {
  const engine = engineFor(legFor([point(0), point(200), point(200, 20)]));
  move(engine, point(195), 0);
  expect(engine.phase).toBe("active");
  expect(engine.instruction).toBe("Links abbiegen auf Straße 1");
  expect(engine.distanceToNext).toBeCloseTo(5);
  move(engine, point(200, 10), 10);
  expect(engine.phase).toBe("arrived");
});
