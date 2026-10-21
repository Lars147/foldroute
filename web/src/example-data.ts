import recording from "./data/bike-transfer.json";
import {
  migrateSettings,
  type Journey,
  type RouteRequest,
  type RoutingSettings,
} from "./model";

// Repository-owned recording, validated alongside real routing fixtures in tests.
export const exampleRecording = {
  ...recording,
  settings: migrateSettings(recording.settings)!,
} as {
  capturedAt: string;
  source: string;
  request: RouteRequest;
  settings: RoutingSettings;
  journey: Journey;
};
