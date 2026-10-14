export const audioPreferenceKey = "foldroute.navigationAudio";
export class NavigationGuidance {
  enabled = true;
  private announced = new Set<string>();
  constructor(private unavailable: (message: string) => void) {
    try {
      this.enabled = localStorage.getItem(audioPreferenceKey) !== "false";
    } catch {
      /* Session-only preference when storage is denied. */
    }
  }
  speak(key: string, text: string, interrupt = true) {
    if (!this.enabled || document.hidden || this.announced.has(key)) return;
    if (
      !("speechSynthesis" in window) ||
      !("SpeechSynthesisUtterance" in window)
    ) {
      this.unavailable(
        "Sprachansagen sind hier nicht verfügbar. Hinweise bleiben sichtbar.",
      );
      return;
    }
    this.announced.add(key);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "de-DE";
    const voices = speechSynthesis.getVoices();
    const voice =
      voices.find((v) => v.lang === "de-DE" && v.localService) ??
      voices.find((v) => v.lang.startsWith("de"));
    if (voice) utterance.voice = voice;
    utterance.onerror = (event) => {
      if (!["canceled", "interrupted"].includes(event.error))
        this.unavailable(
          "Sprachansage nicht verfügbar. Ton erneut einschalten oder Hinweise ablesen.",
        );
    };
    if (interrupt) speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }
  toggle() {
    this.enabled = !this.enabled;
    this.cancel();
    try {
      localStorage.setItem(audioPreferenceKey, String(this.enabled));
    } catch {
      this.unavailable("Toneinstellung gilt nur für diese Sitzung.");
    }
    return this.enabled;
  }
  cancel() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }
  reset() {
    this.cancel();
    this.announced.clear();
  }
}
