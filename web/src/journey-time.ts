import type { Journey } from "./model";
import { dateLabel, clock } from "./ui";

export function journeyEndpointTime(
  journey: Pick<Journey, "departure" | "arrival">,
  endpoint: "departure" | "arrival",
): string {
  const instant = journey[endpoint];
  const crossDay =
    new Date(journey.departure * 1000).toDateString() !==
    new Date(journey.arrival * 1000).toDateString();
  const showDate =
    crossDay ||
    new Date(instant * 1000).toDateString() !== new Date().toDateString();
  return `${showDate ? `${dateLabel(instant)} ` : ""}${clock(instant)}`;
}

export function journeyTimeRange(
  journey: Pick<Journey, "departure" | "arrival">,
): string {
  const departure = new Date(journey.departure * 1000);
  const arrival = new Date(journey.arrival * 1000);
  if (departure.toDateString() !== arrival.toDateString())
    return `${dateLabel(journey.departure)} ${clock(journey.departure)} → ${dateLabel(journey.arrival)} ${clock(journey.arrival)}`;
  const day =
    departure.toDateString() === new Date().toDateString()
      ? ""
      : `${dateLabel(journey.departure)} · `;
  return `${day}${clock(journey.departure)} → ${clock(journey.arrival)}`;
}
