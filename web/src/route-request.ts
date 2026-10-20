import type { RouteStop } from "./model";
import { node } from "./ui";

export function renderRequestStops(
  parent: HTMLElement,
  stops: RouteStop[] = [],
) {
  parent.replaceChildren(
    ...stops.map((stop, index) => {
      const point = node("span", "", "route-request-point route-request-stop");
      const marker = node(
        "span",
        String(index + 1),
        "route-request-marker route-request-stop-marker",
      );
      marker.setAttribute("aria-hidden", "true");
      const name = node("span", "", "route-request-stop-name");
      name.append(
        node("span", `Zwischenziel ${index + 1}: `, "sr-only"),
        document.createTextNode(stop.place.name),
      );
      point.append(marker, name);
      return point;
    }),
  );
}
