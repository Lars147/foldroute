export const mapStyleEvent = "foldroute:map-style";
export const mapStyleKey = "foldroute.mapStyle";
export const mapStyleOptions = [
  { id: "positron", title: "Positron", description: "Hell und reduziert" },
  {
    id: "liberty",
    title: "Straßenkarte",
    description: "Farbig und detailreich",
  },
  { id: "dark", title: "Dunkel", description: "Dunkle Grundkarte" },
] as const;
export type MapStylePreference = (typeof mapStyleOptions)[number]["id"];

function normalize(value: string | null): MapStylePreference {
  return value === "liberty" || value === "dark" ? value : "positron";
}

class MapStyleController {
  preference: MapStylePreference = "positron";
  storageFailed = false;

  initialize() {
    try {
      this.preference = normalize(localStorage.getItem(mapStyleKey));
    } catch {
      this.storageFailed = true;
    }
    window.addEventListener("storage", (event) => {
      if (event.key === mapStyleKey || event.key === null) {
        this.preference = normalize(event.newValue);
        this.apply();
      }
    });
    this.apply();
  }

  set(value: MapStylePreference) {
    this.preference = value;
    try {
      localStorage.setItem(mapStyleKey, value);
      this.storageFailed = false;
    } catch {
      this.storageFailed = true;
    }
    this.apply();
  }

  // Called within the app's existing local-data deletion transaction.
  reset() {
    localStorage.removeItem(mapStyleKey);
    this.preference = "positron";
    this.storageFailed = false;
    this.apply();
  }

  private apply() {
    document.documentElement.dataset.mapStyle = this.preference;
    window.dispatchEvent(new Event(mapStyleEvent));
  }
}

export const mapStyle = new MapStyleController();
