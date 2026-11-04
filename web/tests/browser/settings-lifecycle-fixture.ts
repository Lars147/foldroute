import { flushSync, mount } from "svelte";
import AppRoot from "../../src/components/AppRoot.svelte";
import {
  appPresentation,
  installAppPresentation,
} from "../../src/app-presentation";
import { defaults, type RoutingSettings } from "../../src/model";
import { SettingsValidation } from "../../src/settings-validation";

const bindings: { value: RoutingSettings; changes: number[] }[] = [];

export function mountSettingsFixture() {
  let clear = () => {};
  const root = mount(AppRoot, {
    target: document.getElementById("settings-fixture")!,
    props: { onDispose: () => clear() },
  });
  flushSync();
  clear = installAppPresentation(root.presentation());
  document.getElementById("main")!.inert = false;
  document.getElementById("search-view")!.hidden = true;
  document.getElementById("settings-view")!.hidden = false;
  document.body.dataset.view = "settings";
  replaceSettingsBinding(15);
}

export function replaceSettingsBinding(speed: number) {
  const binding = {
    value: {
      ...structuredClone(defaults),
      cyclingSpeedKilometersPerHour: speed,
    },
    changes: [] as number[],
  };
  bindings.push(binding);
  appPresentation().settings.render({
    read: () => binding.value,
    change: (next) => {
      binding.value = next;
      binding.changes.push(next.cyclingSpeedKilometersPerHour);
    },
    validation: new SettingsValidation(
      document.getElementById("settings-form")!,
    ),
  });
  flushSync();
}

export function settingsBindingChanges() {
  return bindings.map((binding) => [...binding.changes]);
}

export function clearSettingsBinding() {
  appPresentation().settings.clear();
  flushSync();
}
