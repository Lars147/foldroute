import { distance } from "./geometry";
import { quality, type LocationFix } from "./live-location";
import { movement, type NavigationEngine } from "./navigation-engine";

/** Presentation state only; manual and automatic progress keep their own rules. */
export class NavigationCompletion {
  private engine?: NavigationEngine;
  private path?: NavigationEngine["navigationPath"];
  private legIndex = -1;
  private available = false;

  reset() {
    this.engine = undefined;
    this.path = undefined;
    this.legIndex = -1;
    this.available = false;
  }

  update(
    engine?: NavigationEngine,
    fix?: LocationFix,
    current = false,
    now = Date.now(),
  ): boolean {
    if (!engine || engine.phase !== "active") {
      this.reset();
      return false;
    }
    if (
      engine !== this.engine ||
      engine.navigationPath !== this.path ||
      engine.progress.legIndex !== this.legIndex
    ) {
      this.reset();
      this.engine = engine;
      this.path = engine.navigationPath;
      this.legIndex = engine.progress.legIndex;
    }
    if (!movement(engine.leg)) return true;
    if (
      current &&
      fix &&
      quality(fix, now) === "current" &&
      fix.accuracy <= 50
    ) {
      const targetDistance = distance(fix, engine.leg.to);
      if (targetDistance > 150) this.available = false;
      else if (
        targetDistance <= 100 &&
        engine.hasMovementPath &&
        engine.remainingMeters <= 100
      )
        this.available = true;
    }
    return this.available;
  }
}
