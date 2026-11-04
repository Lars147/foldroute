import { describe, expect, it } from "vitest";
import {
  updateAvailable,
  updateBlockedReason,
  updatePresentation,
  type UpdateContext,
  type UpdateEnvironment,
  type UpdateState,
} from "../src/pwa-update-state";

const state: UpdateState = {
  dismissed: false,
  checking: false,
  checked: false,
  applying: false,
  reloadNeeded: false,
  error: "",
};
const home: UpdateContext = { home: true };
const environment: UpdateEnvironment = {
  startupReady: true,
  visible: true,
  overlayOpen: false,
  searchFocused: false,
  online: true,
  controlled: true,
  waiting: true,
  installing: false,
};

describe("PWA update presentation policy", () => {
  it("does not offer a reload for the first installation", () => {
    const firstInstall = { ...environment, controlled: false };
    expect(updateAvailable(state, firstInstall)).toBe(false);
    expect(updatePresentation(state, home, firstInstall)).toMatchObject({
      hasUpdate: false,
      showBanner: false,
      reloadHidden: true,
    });
    expect(
      updateAvailable({ ...state, reloadNeeded: true }, firstInstall),
    ).toBe(true);
  });

  it.each([{ startupReady: false }, { visible: false }, { overlayOpen: true }])(
    "blocks both entrypoints while the environment is unavailable: %j",
    (override) => {
      const unavailable = { ...environment, ...override };
      expect(updateBlockedReason(home, unavailable)).toBeTruthy();
      expect(updateBlockedReason(home, unavailable, true)).toBeTruthy();
      expect(updatePresentation(state, home, unavailable)).toMatchObject({
        showBanner: false,
        reloadHidden: true,
      });
    },
  );

  it("allows an explicit settings reload for a draft but never for active navigation", () => {
    const draft = { home: true, draftReason: "Ungespeicherter Entwurf" };
    const focused = { ...environment, searchFocused: true };
    expect(updateBlockedReason(draft, focused)).toBe(
      "Beende zuerst die Eingabe.",
    );
    expect(updateBlockedReason(draft, focused, true)).toBeUndefined();
    expect(updatePresentation(state, draft, focused)).toMatchObject({
      showBanner: false,
      reloadHidden: false,
    });
    const navigating = { ...draft, blockedReason: "Navigation läuft" };
    expect(updateBlockedReason(navigating, environment)).toBe(
      "Navigation läuft",
    );
    expect(updateBlockedReason(navigating, environment, true)).toBe(
      "Navigation läuft",
    );
    expect(
      updatePresentation(state, navigating, environment).reloadHidden,
    ).toBe(true);
  });

  it("dismisses only the banner and preserves the settings update action", () => {
    expect(
      updatePresentation({ ...state, dismissed: true }, home, environment),
    ).toMatchObject({
      hasUpdate: true,
      showBanner: false,
      showAvailability: true,
      reloadHidden: false,
    });
  });

  it("prevents duplicate reload actions while an update is applying", () => {
    expect(
      updatePresentation({ ...state, applying: true }, home, environment),
    ).toMatchObject({
      showBanner: false,
      showAvailability: false,
      reloadHidden: true,
      checkHidden: true,
      checkDisabled: true,
      status: "App wird aktualisiert …",
    });
  });

  it("keeps the available update discoverable away from the home screen", () => {
    expect(
      updatePresentation(state, { home: false }, environment),
    ).toMatchObject({
      hasUpdate: true,
      showBanner: false,
      showAvailability: true,
      reloadHidden: false,
    });
  });
});
