import type { Place } from "./model";

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
  heading?: number;
  speed?: number;
}
export type LocationQuality = "current" | "inaccurate" | "stale";
export class LocationError extends Error {
  constructor(
    readonly reason:
      "permission-denied" | "timeout" | "unavailable" | "unusable",
    message: string,
  ) {
    super(message);
    this.name = "LocationError";
  }
}
const permissionDeniedMessage =
  "Standortzugriff blockiert. Öffne die Website-Einstellungen neben der Adressleiste und erlaube den Standortzugriff. Prüfe auch die Ortungsdienste in den Systemeinstellungen. Tippe danach auf „Standort erneut anfragen“.";
const timeoutMessage =
  "Standortabfrage dauert zu lange. Bitte erneut versuchen.";
function positionError(code: number) {
  return code === 1
    ? new LocationError("permission-denied", permissionDeniedMessage)
    : code === 3
      ? new LocationError("timeout", timeoutMessage)
      : new LocationError(
          "unavailable",
          "Standort konnte nicht aktualisiert werden. Bitte erneut versuchen.",
        );
}
export const locationLabel = (quality: LocationQuality) =>
  quality === "stale"
    ? "Letzter Standort – nicht aktuell"
    : quality === "inaccurate"
      ? "Standort ungenau"
      : "Dein Standort";
export function quality(fix: LocationFix, now = Date.now()): LocationQuality {
  return Math.abs(now - fix.timestamp) > 60000
    ? "stale"
    : fix.accuracy > 100
      ? "inaccurate"
      : "current";
}
export function readFix(
  position: GeolocationPosition,
): LocationFix | undefined {
  const { latitude, longitude, accuracy } = position.coords;
  const timestamp = position.timestamp;
  if (
    ![latitude, longitude, accuracy, timestamp].every(Number.isFinite) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    accuracy < 0
  )
    return;
  const { heading, speed } = position.coords;
  return {
    latitude,
    longitude,
    accuracy,
    timestamp,
    ...(heading !== null &&
    Number.isFinite(heading) &&
    heading >= 0 &&
    heading < 360
      ? { heading }
      : {}),
    ...(speed !== null && Number.isFinite(speed) && speed >= 0
      ? { speed }
      : {}),
  };
}
export const fixPlace = (fix: LocationFix): Place => ({
  latitude: fix.latitude,
  longitude: fix.longitude,
  name: "Aktueller Standort",
  detail: "",
});
export function announceLocation(position: GeolocationPosition) {
  window.dispatchEvent(
    new CustomEvent("foldroute-location", { detail: position }),
  );
}

/** Owns one foreground subscription. Fixes never become route origins or persisted data. */
export class LiveLocation {
  private active = false;
  private watch?: number;
  private generation = 0;
  private permission?: PermissionStatus;
  private sessionAllowed = false;
  private fix?: LocationFix;
  private failure?: LocationError;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: {
    accurate: boolean;
    resolve: (fix: LocationFix) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private changed: (
      fix?: LocationFix,
      state?: LocationQuality,
      error?: LocationError,
    ) => void,
  ) {
    window.addEventListener("foldroute-location", (event) => {
      this.accept((event as CustomEvent<GeolocationPosition>).detail);
      this.sessionAllowed = true;
      if (this.active) this.start();
    });
  }
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    this.generation++;
    if (!active) {
      this.stop();
      if (this.permission) this.permission.onchange = null;
      this.permission = undefined;
      this.sessionAllowed = false;
      this.cancelCenter();
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.publish();
    this.timer = setInterval(() => this.publish(), 5000);
    if (this.sessionAllowed) this.start(true);
    void this.checkPermission(this.generation);
  }
  private async checkPermission(generation: number) {
    if (!navigator.permissions?.query) return;
    let permission: PermissionStatus;
    // Some browsers expose Permissions but cannot query geolocation.
    try {
      permission = await navigator.permissions.query({ name: "geolocation" });
    } catch {
      return;
    }
    if (generation !== this.generation || !this.active) return;
    if (this.permission) this.permission.onchange = null;
    this.permission = permission;
    const update = () => {
      if (!this.active || this.permission !== permission) return;
      if (permission.state === "granted") this.start();
      else if (permission.state === "denied" || !this.pending) {
        this.stop();
        this.sessionAllowed = false;
        this.fix = undefined;
        this.failure =
          permission.state === "denied" ? positionError(1) : undefined;
        this.publish();
        if (this.failure) this.fail(this.failure);
        else this.cancelCenter();
      }
    };
    permission.onchange = update;
    update();
  }
  private start(explicit = false) {
    if (!this.active || this.watch !== undefined) return;
    if (
      !explicit &&
      this.permission?.state !== "granted" &&
      !this.sessionAllowed
    )
      return;
    if (!window.isSecureContext || !navigator.geolocation?.watchPosition) {
      this.failure = new LocationError(
        "unavailable",
        "Standort ist in diesem Browser nicht verfügbar.",
      );
      this.publish();
      this.fail(this.failure);
      return;
    }
    const generation = this.generation;
    this.watch = navigator.geolocation.watchPosition(
      (position) => {
        if (generation !== this.generation || !this.active) return;
        this.accept(position);
      },
      (error) => {
        if (generation !== this.generation || !this.active) return;
        if (error.code === 1) {
          this.stop();
          this.sessionAllowed = false;
          this.fix = undefined;
        }
        this.failure = positionError(error.code);
        this.publish();
        this.fail(this.failure);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 },
    );
  }
  private accept(position: GeolocationPosition) {
    const fix = readFix(position);
    if (!fix || (this.fix && fix.timestamp < this.fix.timestamp)) return;
    this.fix = fix;
    this.failure = undefined;
    this.publish();
    if (
      this.active &&
      this.pending &&
      quality(fix) !== "stale" &&
      (!this.pending.accurate || quality(fix) === "current")
    ) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(fix);
    }
  }
  private publish() {
    this.changed(
      this.fix,
      this.fix ? (this.failure ? "stale" : quality(this.fix)) : undefined,
      this.failure,
    );
  }
  private stop() {
    this.generation++;
    if (this.watch !== undefined) navigator.geolocation.clearWatch(this.watch);
    this.watch = undefined;
  }
  private fail(error: Error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }
  cancelCenter() {
    this.fail(
      new DOMException("Standortzentrierung abgebrochen", "AbortError"),
    );
  }
  center(accurate = false): Promise<LocationFix> {
    this.cancelCenter();
    if (!this.active)
      return Promise.reject(
        new DOMException("Karte nicht sichtbar", "AbortError"),
      );
    if (this.permission && this.permission.state !== "granted") {
      this.fix = undefined;
      this.stop();
    }
    if (
      this.fix &&
      !this.failure &&
      quality(this.fix) !== "stale" &&
      (!accurate || quality(this.fix) === "current")
    ) {
      this.start(true);
      return Promise.resolve(this.fix);
    }
    return new Promise((resolve, reject) => {
      this.pending = {
        accurate,
        resolve,
        reject,
        timer: setTimeout(
          () => this.fail(new LocationError("timeout", timeoutMessage)),
          12000,
        ),
      };
      this.start(true);
      // A low-power lookup can return a usable fix before high-accuracy GPS.
      // Keep the watch running for subsequent, more precise measurements.
      const pending = this.pending;
      const generation = this.generation;
      if (accurate && pending && navigator.geolocation?.getCurrentPosition)
        navigator.geolocation.getCurrentPosition(
          (position) => {
            if (
              this.active &&
              this.generation === generation &&
              this.pending === pending
            )
              this.accept(position);
          },
          () => {}, // The watch and our deadline own failure reporting.
          { enableHighAccuracy: false, maximumAge: 5000, timeout: 5000 },
        );
    });
  }
}
