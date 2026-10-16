import recording from "./data/bike-transfer.json";
import type { Journey, RouteRequest, RoutingSettings } from "./model";

// Repository-owned recording, validated alongside real routing fixtures in tests.
export const exampleRecording = recording as {
  capturedAt: string;
  source: string;
  request: RouteRequest;
  settings: RoutingSettings;
  journey: Journey;
};
