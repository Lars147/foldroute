import { flushSync, mount } from "svelte";
import AppRoot from "../../src/components/AppRoot.svelte";
import {
  appPresentation,
  installAppPresentation,
} from "../../src/app-presentation";

let activations = 0;

export function mountRecoveryFixture() {
  let clear = () => {};
  const root = mount(AppRoot, {
    target: document.getElementById("recovery-fixture")!,
    props: { onDispose: () => clear() },
  });
  flushSync();
  const presentation = root.presentation();
  clear = installAppPresentation(presentation);
  document.getElementById("main")!.inert = false;
  document.getElementById("search-view")!.hidden = true;
  document.body.dataset.view = "map";
  const workspace = presentation.workspace;
  workspace.setHidden("map-view", false);
  workspace.setHidden("planning-recovery", false);
  workspace.setText("recovery-label", "Erneut versuchen");
  workspace.setRecoveryToast(true);
  workspace.setCommand("recover-planning", () => activations++);
  workspace.updateToast({
    visible: true,
    planningId: "recovery-focus",
    stage: "error",
    message: "Routenoptimierung: Zeitlimit erreicht",
  });
  // Opening a dialog has its own focus policy. A nonmodal dialog makes all
  // three presentation hosts visible while testing only toast relocation.
  document.querySelector<HTMLDialogElement>("#alternatives-dialog")!.show();
}

export function moveRecoveryToast(placement: "root" | "inline" | "sheet") {
  const workspace = appPresentation().workspace;
  workspace.updateLayout({
    desktop: matchMedia("(min-width: 900px)").matches,
    requestPreview: false,
    restored: false,
    example: false,
  });
  workspace.setToastPlacement(placement);
}

export function recoveryActivations() {
  return activations;
}
