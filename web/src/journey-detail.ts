import { type Journey, type Leg, kindNames, transition } from "./model";
import { clock, dateLabel, duration, icon, legColors, node } from "./ui";

const preparation = (leg: Leg) => ["fold", "unfold", "wait"].includes(leg.kind);

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

export function detailTime(journey: Journey, instant: number): string {
  const crossDay =
    new Date(journey.departure * 1000).toDateString() !==
    new Date(journey.arrival * 1000).toDateString();
  return `${crossDay ? `${dateLabel(instant)} ` : ""}${clock(instant)}`;
}

export function renderJourneyDetails(
  journey: Journey,
  restored: boolean,
): HTMLOListElement {
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
      item.style.setProperty("--leg-color", legColors[leg.kind]);
      const symbol = icon(leg.kind);
      symbol.classList.add("leg-symbol");
      const copy = node("div", "", "detail-copy");
      const start = detailTime(journey, leg.start),
        end = detailTime(journey, leg.end);
      if (leg.kind === "transit") {
        copy.append(
          node(
            "strong",
            `Ab ${start} · ${leg.line || "ÖPNV"}`,
            "detail-heading",
          ),
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
        const arrival = node("div", "", "detail-arrival");
        arrival.append(
          node("strong", `${end} · Ausstieg`),
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
          node(
            "small",
            `${start} – ${end} · ${duration(leg.end - leg.start)}`,
            "detail-meta",
          ),
        );
        // The following step names the same place; retain a different location.
        const next = group[group.indexOf(leg) + 1];
        if (!next || next.from.name !== leg.from.name)
          copy.append(node("p", leg.from.name, "detail-place"));
      } else if (leg.kind === "stop") {
        copy.append(
          node("strong", `Zwischenziel: ${leg.to.name}`, "detail-heading"),
          node("small", `${start} – ${end}`, "detail-meta"),
          node(
            "p",
            `Geplanter Aufenthalt: ${leg.stop?.stayMinutes ?? Math.ceil((leg.end - leg.start) / 60)} min · Weiterfahrt ${end}`,
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
          node(
            "small",
            `${start} – ${end} · ${duration(leg.end - leg.start)}`,
            "detail-meta",
          ),
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
