/** Update policy is independent of DOM, service workers and browser storage. */
export interface UpdateContext {
  home: boolean;
  blockedReason?: string;
  draftReason?: string;
}
export interface UpdateEnvironment {
  startupReady: boolean;
  visible: boolean;
  overlayOpen: boolean;
  searchFocused: boolean;
  online: boolean;
  controlled: boolean;
  waiting: boolean;
  installing: boolean;
}
export interface UpdateState {
  dismissed: boolean;
  checking: boolean;
  checked: boolean;
  applying: boolean;
  reloadNeeded: boolean;
  error: string;
}

export function updateAvailable(
  state: UpdateState,
  environment: UpdateEnvironment,
) {
  return state.reloadNeeded || (environment.controlled && environment.waiting);
}

export function updateBlockedReason(
  context: UpdateContext,
  environment: UpdateEnvironment,
  fromSettings = false,
): string | undefined {
  if (!environment.startupReady || !environment.visible)
    return "Sobald die App bereit ist, kannst du neu laden.";
  if (environment.overlayOpen) return "Schließe zuerst den geöffneten Dialog.";
  if (!fromSettings && environment.searchFocused)
    return "Beende zuerst die Eingabe.";
  return (
    context.blockedReason ?? (fromSettings ? undefined : context.draftReason)
  );
}

export function updatePresentation(
  state: UpdateState,
  context: UpdateContext,
  environment: UpdateEnvironment,
) {
  const hasUpdate = updateAvailable(state, environment);
  const blocked = updateBlockedReason(context, environment);
  const settingsBlocked = updateBlockedReason(context, environment, true);
  const downloading = environment.controlled && environment.installing;
  const status = state.applying
    ? "App wird aktualisiert …"
    : hasUpdate
      ? [
          state.error,
          settingsBlocked ?? "Zum Aktualisieren wird die App neu geladen.",
        ]
          .filter(Boolean)
          .join(" ")
      : !environment.online
        ? "Offline. Verbinde dich mit dem Internet, um nach Updates zu suchen."
        : state.error ||
          (downloading
            ? "Update wird heruntergeladen …"
            : state.checking
              ? "Suche läuft …"
              : state.checked
                ? "Du bist auf dem neuesten Stand."
                : "Updates werden automatisch im Hintergrund geprüft.");
  return {
    hasUpdate,
    showBanner:
      hasUpdate &&
      !state.dismissed &&
      !state.applying &&
      !blocked &&
      context.home,
    showAvailability: hasUpdate && !state.applying,
    status,
    checkHidden: hasUpdate || state.applying,
    checkDisabled:
      state.checking || downloading || state.applying || !environment.online,
    checkBusy: state.checking || downloading,
    reloadHidden: !hasUpdate || !!settingsBlocked || state.applying,
  };
}
