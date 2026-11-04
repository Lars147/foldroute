import { flushSync, mount, unmount } from "svelte";
import JourneyDetails from "./components/JourneyDetails.svelte";
import type { Journey, Leg } from "./model";
import type { JourneyPresentation } from "./journey-detail";

export type { JourneyPresentation } from "./journey-detail";
export interface JourneyDetailOptions {
  presentation?: JourneyPresentation | "navigation";
  main?: Leg;
  compactMovement?: boolean;
}
export interface JourneyDetailsHandle {
  element: HTMLOListElement;
  setMovementSummary(text: string): void;
  dispose(): void;
}
const mounted = new WeakMap<HTMLOListElement, JourneyDetailsHandle>();

export function createJourneyDetails(
  journey: Journey,
  restored: boolean,
  options: JourneyDetailOptions = {},
): JourneyDetailsHandle {
  const element = document.createElement("ol");
  element.className = "journey-legs";
  const component = mount(JourneyDetails, {
    target: element,
    props: { journey, restored, options },
  });
  flushSync();
  const handle: JourneyDetailsHandle = {
    element,
    setMovementSummary(text) {
      flushSync(() => component.setMovementSummary(text));
    },
    dispose() {
      if (mounted.get(element) !== handle) return;
      mounted.delete(element);
      void unmount(component);
    },
  };
  mounted.set(element, handle);
  return handle;
}

/** Compatibility boundary for callers that still own the surrounding legacy view. */
export function renderJourneyDetails(
  journey: Journey,
  restored: boolean,
  presentation: JourneyPresentation = "live",
): HTMLOListElement {
  return createJourneyDetails(journey, restored, { presentation }).element;
}

export function disposeJourneyDetailsWithin(container: HTMLElement) {
  for (const element of container.querySelectorAll<HTMLOListElement>(
    "ol.journey-legs",
  ))
    mounted.get(element)?.dispose();
}
