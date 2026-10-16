import { bikeBoardings, type Journey } from "./model";
import { freshTransit, movement, projectPath } from "./navigation-engine";
import { quality, type LocationFix } from "./live-location";
import { clock } from "./ui";

export interface ConnectionAssessment {
  status: "ready" | "risk" | "departed" | "cancelled" | "unknown";
  id: string;
  message: string;
}

export function blocksNavigation(assessment: ConnectionAssessment) {
  return assessment.status === "departed" || assessment.status === "cancelled";
}

export function assessConnection(
  journey: Journey,
  index: number,
  now: number,
  options: {
    remainingMovement?: number;
    onboard?: boolean;
    fix?: LocationFix;
  } = {},
): ConnectionAssessment {
  const cancelled = journey.legs
    .slice(index)
    .find((leg) => leg.kind === "transit" && leg.transitStatus?.cancelled);
  if (cancelled)
    return {
      status: "cancelled",
      id: `cancelled-${cancelled.navigationId ?? journey.legs.indexOf(cancelled)}`,
      message: `${cancelled.line ?? "ÖPNV"}: Fahrt oder benötigter Halt fällt aus.`,
    };
  const boardings = bikeBoardings(journey);
  let earliest = now,
    previousTransit = false,
    transferWalk = false;
  let warning: ConnectionAssessment | undefined;
  let unknown = false;
  for (let i = index; i < journey.legs.length; i++) {
    const leg = journey.legs[i];
    const duration = Math.max(0, leg.end - leg.start);
    if (leg.kind === "transit") {
      const current = freshTransit(leg, now);
      const onboard = i === index && options.onboard;
      unknown ||= !current;
      if (!onboard && current && leg.start < now)
        return {
          status: "departed",
          id: `departed-${leg.navigationId ?? i}`,
          message: `Abfahrt von ${leg.line ?? "ÖPNV"} um ${clock(leg.start)} liegt zurück.`,
        };
      let buffer =
        boardings.includes(i) || (previousTransit && !transferWalk) ? 180 : 0;
      if (
        journey.legs[index].kind === "wait" &&
        journey.legs.slice(index + 1, i).every((part) => part.kind === "wait")
      )
        buffer = Math.min(buffer, Math.max(0, journey.legs[index].end - now));
      if (!onboard && current && earliest + buffer > leg.start && !warning)
        warning = {
          status: "risk",
          id: `connection-${leg.navigationId ?? i}`,
          message: `Anschluss an ${leg.line ?? "ÖPNV"} um ${clock(leg.start)} gefährdet.`,
        };
      earliest = Math.max(earliest, leg.end);
      previousTransit = true;
      transferWalk = false;
    } else if (leg.kind === "stop") {
      earliest = Math.max(
        leg.end,
        i === index ? earliest : earliest + (leg.stop?.stayMinutes ?? 0) * 60,
      );
      previousTransit = false;
      transferWalk = false;
    } else if (leg.kind !== "wait") {
      let remaining = duration;
      if (i === index) {
        if (movement(leg)) {
          remaining = options.remainingMovement ?? duration;
          const fix = options.fix;
          if (
            fix &&
            quality(fix, now * 1000) === "current" &&
            fix.accuracy <= 50
          ) {
            const path =
              leg.coordinates.length > 1 ? leg.coordinates : [leg.from, leg.to];
            const projection = projectPath(fix, path);
            if (
              projection.length &&
              projection.distance <= Math.max(40, fix.accuracy)
            )
              remaining =
                duration *
                Math.max(0, 1 - projection.meters / projection.length);
          }
        } else remaining = Math.min(duration, Math.max(0, leg.end - now));
      }
      earliest += remaining;
      if (leg.kind === "walk") transferWalk = true;
    }
  }
  return (
    warning ??
    (unknown
      ? {
          status: "unknown",
          id: "unknown",
          message:
            "Erreichbarkeit unklar · Fahrtdaten fehlen oder sind veraltet.",
        }
      : { status: "ready", id: "ready", message: "" })
  );
}
