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
const permissionDeniedMessage =
  "Standortzugriff blockiert. Öffne die Website-Einstellungen neben der Adressleiste und erlaube den Standortzugriff. Prüfe auch die Ortungsdienste in den Systemeinstellungen. Tippe danach auf „Standort erneut anfragen“.";
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
  private failed = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: {
    accurate: boolean;
    resolve: (fix: LocationFix) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private changed: (fix?: LocationFix, state?: LocationQuality) => void,
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
        this.changed();
        if (permission.state === "denied")
          this.fail(new Error(permissionDeniedMessage));
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
      this.fail(new Error("Standort ist in diesem Browser nicht verfügbar."));
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
          this.changed();
        } else {
          this.failed = true;
          this.publish();
        }
        this.fail(
          new Error(
            error.code === 1
              ? permissionDeniedMessage
              : "Standort konnte nicht aktualisiert werden. Bitte erneut versuchen.",
          ),
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 },
    );
  }
  private accept(position: GeolocationPosition) {
    const fix = readFix(position);
    if (!fix || (this.fix && fix.timestamp < this.fix.timestamp)) return;
    this.fix = fix;
    this.failed = false;
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
      this.fix ? (this.failed ? "stale" : quality(this.fix)) : undefined,
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
      !this.failed &&
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
          () =>
            this.fail(
              new Error(
                "Standortabfrage dauert zu lange. Bitte Standortzugriff im Browser und in den Systemeinstellungen erlauben und erneut versuchen.",
              ),
            ),
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
