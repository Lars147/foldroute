import { announceLocation, geolocationError } from "./live-location";
import type { Coordinate, Place } from "./model";

let lastLocation: { coordinate: Coordinate; timestamp: number } | undefined;
let searchLocationRequest:
  { controller: AbortController; promise: Promise<boolean> } | undefined;
export function clearSearchLocation() {
  searchLocationRequest?.controller.abort();
  searchLocationRequest = undefined;
  lastLocation = undefined;
}
export function searchCenter(): Coordinate | undefined {
  return lastLocation && Date.now() - lastLocation.timestamp <= 60000
    ? lastLocation.coordinate
    : undefined;
}
export function prepareSearchLocation(): Promise<boolean> {
  if (searchCenter()) return Promise.resolve(false);
  if (searchLocationRequest) return searchLocationRequest.promise;
  if (!window.isSecureContext || !navigator.permissions?.query)
    return Promise.resolve(false);
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const permission = await navigator.permissions.query({
        name: "geolocation",
      });
      if (permission.state !== "granted" || controller.signal.aborted)
        return false;
      await requestLocation(controller.signal);
      return true;
    } catch {
      // Optional search bias must not block suggestions or request permission.
      return false;
    }
  })().finally(() => {
    if (searchLocationRequest?.controller === controller)
      searchLocationRequest = undefined;
  });
  searchLocationRequest = { controller, promise };
  return promise;
}
function requestLocation(signal?: AbortSignal): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (!window.isSecureContext) {
      reject(geolocationError(2));
      return;
    }
    if (!navigator.geolocation) {
      reject(geolocationError(2));
      return;
    }
    const abort = () => reject(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return;
        lastLocation = {
          coordinate: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
          timestamp: position.timestamp,
        };
        resolve(position);
      },
      (error) => {
        signal?.removeEventListener("abort", abort);
        reject(geolocationError(error.code));
      },
      { timeout: 12000, maximumAge: 60000 },
    );
  });
}
export async function locate(signal?: AbortSignal): Promise<Place> {
  const position = await requestLocation(signal);
  signal?.throwIfAborted();
  announceLocation(position);
  return {
    name: "Aktueller Standort",
    detail: "Standort dieser Abfrage",
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };
}
