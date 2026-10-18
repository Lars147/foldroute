import type { PlanningPhase, PlanningUpdate } from "./model";
import type { PlanningState } from "./planning-state";

export const stoppedSearchMessage =
  "Weitere Suche beendet. Gefundene Verbindungen bleiben verfügbar.";

const phaseMessages: Record<PlanningPhase, string> = {
  base: "Weitere Verbindungen werden gesucht …",
  "bike-transfers": "Wir prüfen weitere Rad-Umstiege …",
  walking: "Wir prüfen kürzere Fußwege …",
  via: "Wir prüfen weitere Verbindungen über deine Zwischenziele …",
};
const incompleteMessages: Record<PlanningPhase, string> = {
  base: "Weitere Verbindungen: Suche unvollständig.",
  "bike-transfers": "Weitere Rad-Umstiege: Suche unvollständig.",
  walking: "Kürzere Fußwege: Prüfung unvollständig.",
  via: "Zwischenziele: Suche unvollständig.",
};
export function searchMessage(
  status: PlanningUpdate["status"],
  phase: PlanningPhase,
  incompletePhases: PlanningPhase[],
  usable: boolean,
  issues: string[],
) {
  if (status === "complete") return "Suche abgeschlossen.";
  if (status === "searching")
    return usable ? phaseMessages[phase] : "Verbindungen werden gesucht …";
  if (issues.length) return [...new Set(issues)].join(" ");
  return incompletePhases.length
    ? incompletePhases.map((value) => incompleteMessages[value]).join(" ")
    : "Zusatzsuche unvollständig.";
}
function optimizationMessage(issues: string[]): string {
  const fallback = "Optimierung nicht vollständig.";
  const messages = new Set(
    issues.map((issue) => {
      const limit =
        /^(?:Suche nach weiteren Rad-Umstiegen|Suche über Zwischenziele|Prüfung kürzerer Fußwege): (Zeitlimit|Anfragelimit) erreicht\.$/.exec(
          issue,
        );
      if (
        limit?.[1] === "Zeitlimit" ||
        issue === "Der Dienst hat nicht rechtzeitig geantwortet."
      )
        return "Optimierung: Zeitlimit erreicht";
      if (limit) return `Optimierung: ${limit[1]} erreicht.`;
      return fallback;
    }),
  );
  return messages.size === 1 ? [...messages][0] : fallback;
}

export function planningProgress(state: PlanningState) {
  const ready = !!(
    !state.locating &&
    !state.pendingRequest &&
    !state.staleReason &&
    !state.restored &&
    state.calculationId &&
    state.journeys.length
  );
  return {
    ready,
    optimizing: ready && state.busy,
    loading: state.busy && !ready,
    message: !ready
      ? state.message
      : state.busy
        ? ""
        : state.searchStatus === "partial"
          ? optimizationMessage(state.issues)
          : state.searchStatus === "complete"
            ? ""
            : state.message,
  };
}
