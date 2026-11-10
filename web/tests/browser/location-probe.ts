interface LocationProbe {
  started: number;
  stopped: number;
  refreshLookups: number;
  refreshSilent: boolean;
  hide(hidden: boolean): void;
}

export interface NavigationLocationProbe extends LocationProbe {
  readonly active: number;
  readonly spoken: string[];
  readonly cancelled: number;
  quickLookups: number;
  silent: boolean;
  cachedAt?: number;
  lastWatchOptions?: PositionOptions;
  lastQuickOptions?: PositionOptions;
  lastRefreshOptions?: PositionOptions;
  fail(code: number): void;
  push(
    latitude: number,
    longitude: number,
    heading?: number,
    accuracy?: number,
    age?: number,
    speed?: number | null,
  ): void;
}

export interface LiveLocationProbe extends LocationProbe {
  permission(value: PermissionState): void;
  push(latitude: number, accuracy: number, age?: number): void;
  fail(): void;
}

declare global {
  interface Window {
    navProbe: NavigationLocationProbe;
    liveProbe: LiveLocationProbe;
  }
}

/** Serialized by Playwright; keep all runtime helpers inside this function. */
export function installLocationProbe(options: {
  mode: "navigation" | "live";
  permission?: PermissionState;
}) {
  const navigation = options.mode === "navigation";
  const watchers = new Map<number, PositionCallback>();
  const errors = new Map<number, PositionErrorCallback>();
  let next = 0;
  const permission = {
    state: options.permission ?? "granted",
    onchange: null as (() => void) | null,
  };
  let coords = {
    latitude: 48,
    longitude: 11,
    accuracy: 10,
    heading: navigation ? 90 : null,
    speed: navigation ? (4 as number | null) : null,
    altitude: null,
    altitudeAccuracy: null,
  };
  let lastPosition: GeolocationPosition | undefined;
  const position = (timestamp = Date.now()): GeolocationPosition => ({
    coords: { ...coords, toJSON: () => ({ ...coords }) },
    timestamp,
    toJSON: () => ({ coords, timestamp }),
  });
  const hide = (hidden: boolean) => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const fail = (code = 2) => {
    for (const callback of errors.values())
      callback({
        code,
        message: "Test location unavailable",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
  };
  const push = (
    latitude: number,
    longitude: number,
    heading: number | null,
    accuracy: number,
    age: number,
    speed: number | null = coords.speed,
  ) => {
    coords = { ...coords, latitude, longitude, heading, accuracy, speed };
    lastPosition = position(Date.now() - age);
    for (const callback of watchers.values()) callback(lastPosition);
  };
  const common: LocationProbe = {
    started: 0,
    stopped: 0,
    refreshLookups: 0,
    refreshSilent: true,
    hide,
  };
  const nav: NavigationLocationProbe = {
    ...common,
    quickLookups: 0,
    silent: false,
    get active() {
      return watchers.size;
    },
    get spoken() {
      return window.testSpeech.spoken;
    },
    get cancelled() {
      return window.testSpeech.cancelled;
    },
    fail,
    push(latitude, longitude, heading = 90, accuracy = 10, age = 0, speed = 4) {
      push(latitude, longitude, heading, accuracy, age, speed);
    },
  };
  const live: LiveLocationProbe = {
    ...common,
    permission(value) {
      permission.state = value;
      permission.onchange?.();
    },
    fail,
    push(latitude, accuracy, age = 0) {
      push(latitude, 11.5756, null, accuracy, age);
    },
  };
  const probe = navigation ? nav : live;
  if (navigation) window.navProbe = nav;
  else window.liveProbe = live;
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => permission },
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition(
        success: PositionCallback,
        error: PositionErrorCallback,
        options?: PositionOptions,
      ) {
        const id = ++next;
        watchers.set(id, success);
        errors.set(id, error);
        probe.started++;
        if (navigation) {
          nav.lastWatchOptions = options;
          setTimeout(() => {
            if (!nav.silent) success(position());
          }, 0);
        }
        return id;
      },
      clearWatch(id: number) {
        probe.stopped++;
        watchers.delete(id);
        errors.delete(id);
      },
      getCurrentPosition(
        success: PositionCallback,
        _error?: PositionErrorCallback,
        options?: PositionOptions,
      ) {
        if (!navigation) {
          if (!options?.enableHighAccuracy)
            throw new Error("This fixed-origin plan must not query its origin");
          live.refreshLookups++;
          if (!live.refreshSilent && lastPosition)
            success({ ...lastPosition, timestamp: Date.now() });
          return;
        }
        if (options?.enableHighAccuracy) {
          nav.refreshLookups++;
          nav.lastRefreshOptions = options;
          if (nav.refreshSilent) return;
        } else {
          nav.quickLookups++;
          nav.lastQuickOptions = options;
        }
        if (nav.cachedAt !== undefined || !nav.silent)
          success(position(nav.cachedAt ?? Date.now()));
      },
    },
  });
}
