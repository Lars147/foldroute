import type { Leg, TransitCancellationReason } from "./model";

export function transitCancellationReason(
  trip: boolean,
  boarding: boolean,
  alighting: boolean,
): TransitCancellationReason | undefined {
  if (trip) return "trip";
  if (boarding && alighting) return "both-stops";
  if (boarding) return "boarding";
  if (alighting) return "alighting";
  return undefined;
}

export function transitCancellationMessage(leg: Leg): string {
  switch (leg.transitStatus?.cancellationReason) {
    case "trip":
      return "Fahrt fällt aus";
    case "boarding":
      return `Halt in ${leg.from.name} entfällt`;
    case "alighting":
      return `Halt in ${leg.to.name} entfällt`;
    case "both-stops":
      return `Halte in ${leg.from.name} und ${leg.to.name} entfallen`;
    default:
      return "Verbindung nicht nutzbar";
  }
}
