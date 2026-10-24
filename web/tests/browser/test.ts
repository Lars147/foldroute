import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type * from "@playwright/test";

declare global {
  interface Window {
    testSpeech: { spoken: string[]; cancelled: number };
  }
}

// Never delegate test announcements to the host's speech service. Context-level
// initialization also covers popups, child frames and subsequent navigations.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      const speech = { spoken: [] as string[], cancelled: 0 };
      window.testSpeech = speech;
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        configurable: true,
        value: class {
          constructor(public text = "") {}
        },
      });
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => [],
          cancel: () => speech.cancelled++,
          speak: (utterance: { text: string }) =>
            speech.spoken.push(utterance.text),
        },
      });
    });
    await use(context);
  },
});
