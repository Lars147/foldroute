import { type Journey, type Leg, kindNames, transition } from "./model";
import { clock, dateLabel, duration, icon, legTextColors, node } from "./ui";

const preparation = (leg: Leg) => ["fold", "unfold", "wait"].includes(leg.kind);
export type JourneyPresentation = "live" | "example";

/** Group preparation with the next movement without crossing a planned stop. */
export function detailGroups(journey: Journey): Leg[][] {
  const groups: Leg[][] = [];
  let pending: Leg[] = [];
  let coveredUntil: number | undefined;
  for (const leg of journey.legs) {
    if (coveredUntil !== undefined && leg.start - coveredUntil >= 60)
      pending.push(transition("wait", leg.from, coveredUntil, leg.start));
    coveredUntil = Math.max(coveredUntil ?? leg.end, leg.end);
    if (preparation(leg)) {
      pending.push(leg);
    } else {
      if (leg.kind === "stop" && pending.length) {
        groups.push(pending);
        pending = [];
      }
      groups.push([...pending, leg]);
      pending = [];
    }
  }
  if (pending.length) groups.push(pending);
  return groups;
}

export function detailTime(
  journey: Journey,
  instant: number,
  comparedInstant = journey.departure,
): string {
  const crossDay =
    new Date(journey.departure * 1000).toDateString() !==
      new Date(journey.arrival * 1000).toDateString() ||
    new Date(instant * 1000).toDateString() !==
      new Date(comparedInstant * 1000).toDateString();
  return `${crossDay ? `${dateLabel(instant)} ` : ""}${clock(instant)}`;
}

export function detailTransitTime(
  journey: Journey,
  leg: Leg,
  event: "departure" | "arrival",
): { time: string; delay?: { time: string; minutes: number } } {
  const actual = event === "departure" ? leg.start : leg.end;
  const scheduled =
    event === "departure"
      ? (leg.scheduledStart ?? leg.transitReference?.scheduledDeparture)
      : (leg.scheduledEnd ?? leg.transitReference?.scheduledArrival);
  if (!leg.realtime || scheduled === undefined || actual - scheduled < 60)
    return { time: detailTime(journey, actual) };
  return {
    time: detailTime(journey, scheduled, actual),
    delay: {
      time: detailTime(journey, actual, scheduled),
      minutes: Math.floor((actual - scheduled) / 60),
    },
  };
}

function renderTransitTime(
  journey: Journey,
  leg: Leg,
  event: "departure" | "arrival",
  restored: boolean,
): HTMLElement[] {
  const time = detailTransitTime(journey, leg, event);
  const departure = event === "departure";
  const heading = node(
    "strong",
    departure
      ? `Ab ${time.time} · ${leg.line || "ÖPNV"}`
      : `${time.time} · Ausstieg`,
    departure ? "detail-heading" : "",
  );
  if (!time.delay) return [heading];
  heading.append(node("span", " (laut Fahrplan)", "sr-only"));
  const prediction = node("p", "", "detail-delay");
  prediction.dataset.event = event;
  const visible = node(
    "span",
    `${time.delay.time} · +${time.delay.minutes} min`,
  );
  visible.setAttribute("aria-hidden", "true");
  prediction.append(
    visible,
    node(
      "span",
      `${restored ? "Gespeicherte Prognose:" : "Voraussichtlich"} ${departure ? "Abfahrt" : "Ankunft"} ${time.delay.time}, ${time.delay.minutes} Minuten Verspätung.`,
      "sr-only",
    ),
  );
  return [heading, prediction];
}

export function renderJourneyDetails(
  journey: Journey,
  restored: boolean,
  presentation: JourneyPresentation = "live",
): HTMLOListElement {
  const example = presentation === "example";
  const list = node("ol", "", "journey-legs");
  for (const group of detailGroups(journey)) {
    const section = node("li", "", "journey-section");
    const steps = node("ol", "", "journey-steps");
    for (const leg of group) {
      const item = node(
        "li",
        "",
        `detail-step${preparation(leg) ? " detail-preparation" : ""}`,
      );
      item.dataset.kind = leg.kind;
      item.style.setProperty("--leg-color", legTextColors[leg.kind]);
      const symbol = icon(leg.kind);
      symbol.classList.add("leg-symbol");
      const copy = node("div", "", "detail-copy");
      const start = example ? "" : detailTime(journey, leg.start),
        end = example ? "" : detailTime(journey, leg.end);
      const interval = example
        ? duration(leg.end - leg.start)
        : `${start} – ${end} · ${duration(leg.end - leg.start)}`;
      if (leg.kind === "transit") {
        if (example)
          copy.append(node("strong", leg.line || "ÖPNV", "detail-heading"));
        else
          copy.append(
            ...renderTransitTime(journey, leg, "departure", restored),
          );
        copy.append(node("p", leg.from.name, "detail-place"));
        if (leg.headsign)
          copy.append(
            node("p", `Richtung ${leg.headsign}`, "detail-direction"),
          );
        if (leg.platform)
          copy.append(
            node("p", `Gleis / Steig ${leg.platform}`, "detail-platform"),
          );
        for (const visit of leg.viaStops ?? [])
          copy.append(
            node(
              "p",
              `Über ${visit.stop.place.name} · ${leg.transitStatus?.missingViaStops?.includes(visit.stop.id) ? "Halt entfällt" : "Im Zug bleiben"}`,
              "detail-place",
            ),
          );
        const arrival = node("div", "", "detail-arrival");
        arrival.append(
          ...(example
            ? [node("strong", "Ausstieg")]
            : renderTransitTime(journey, leg, "arrival", restored)),
          node("p", leg.to.name, "detail-place"),
        );
        if (leg.arrivalPlatform)
          arrival.append(
            node(
              "p",
              `Gleis / Steig ${leg.arrivalPlatform}`,
              "detail-platform",
            ),
          );
        copy.append(
          arrival,
          node(
            "small",
            `${duration(leg.end - leg.start)} Fahrt`,
            "detail-meta",
          ),
        );
        if (!example)
          copy.append(
            node(
              "small",
              restored
                ? "Gespeicherte Fahrplanangabe"
                : leg.realtime
                  ? "Echtzeitdaten zum Zeitpunkt der Abfrage"
                  : "Fahrplanzeit",
              "detail-source",
            ),
          );
      } else if (preparation(leg)) {
        copy.append(
          node("strong", kindNames[leg.kind], "detail-heading"),
          node("small", interval, "detail-meta"),
        );
        // The following step names the same place; retain a different location.
        const next = group[group.indexOf(leg) + 1];
        if (!next || next.from.name !== leg.from.name)
          copy.append(node("p", leg.from.name, "detail-place"));
      } else if (leg.kind === "stop") {
        copy.append(
          node("strong", `Zwischenziel: ${leg.to.name}`, "detail-heading"),
          node(
            "small",
            example ? duration(leg.end - leg.start) : `${start} – ${end}`,
            "detail-meta",
          ),
          node(
            "p",
            `Geplanter Aufenthalt: ${leg.stop?.stayMinutes ?? Math.ceil((leg.end - leg.start) / 60)} min${example ? "" : ` · Weiterfahrt ${end}`}`,
            "detail-place",
          ),
        );
      } else {
        copy.append(
          node(
            "strong",
            `${kindNames[leg.kind]} bis ${leg.to.name}`,
            "detail-heading",
          ),
          node("small", interval, "detail-meta"),
          node("p", `Von ${leg.from.name}`, "detail-place"),
        );
      }
      item.append(symbol, copy);
      steps.append(item);
    }
    section.append(steps);
    list.append(section);
  }
  return list;
}
