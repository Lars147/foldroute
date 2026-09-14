import { expect, it } from "vitest";
import { journeyEffort, type Journey, type LegKind } from "../src/model";

it("sums movement effort across stops without counting folding, waiting or gaps", () => {
  const place = { name: "Ort", detail: "", latitude: 48, longitude: 11 };
  let start = 0;
  const legs = (
    [
      ["bike", 300],
      ["fold", 180],
      ["walk", 90],
      ["transit", 1200],
      ["wait", 120],
      ["unfold", 180],
      ["bike", 600],
      ["stop", 1800],
      ["bike", 300],
      ["walk", 30],
    ] as [LegKind, number][]
  ).map(([kind, seconds]) => {
    const leg = {
      kind,
      from: place,
      to: place,
      start,
      end: start + seconds,
      distance: 100,
      coordinates: [place],
    };
    start += seconds + 60;
    return leg;
  });
  const journey: Journey = {
    id: "mixed",
    origin: place,
    destination: place,
    departure: 0,
    arrival: start,
    transfers: 2,
    isDirect: false,
    legs,
  };
  expect(journeyEffort(journey)).toEqual({
    cyclingSeconds: 1200,
    walkingSeconds: 120,
    transfers: 2,
  });
  expect(
    journeyEffort({
      ...journey,
      transfers: 0,
      legs: legs.filter((l) => l.kind === "transit"),
    }),
  ).toEqual({ cyclingSeconds: 0, walkingSeconds: 0, transfers: 0 });
});
