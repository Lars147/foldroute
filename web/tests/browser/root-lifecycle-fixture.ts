import { mount, unmount, flushSync } from "svelte";
import AppRoot from "../../src/components/AppRoot.svelte";
import ExampleRoot from "../../src/components/ExampleRoot.svelte";
import {
  installAppPresentation,
  appPresentation,
} from "../../src/app-presentation";

export async function mountRootCycles(mode: "live" | "example") {
  const target = document.getElementById("root-fixture")!;
  let disposals = 0;
  const cycles = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    let clear = () => {};
    const root = mount(mode === "live" ? AppRoot : ExampleRoot, {
      target,
      props: {
        onDispose: () => {
          disposals++;
          clear();
        },
      },
    });
    flushSync();
    const presentation = root.presentation();
    // A stale registration makes the next mount fail immediately, just as
    // bootstrap would, rather than allowing two roots to compete for IDs.
    clear = installAppPresentation(presentation);
    const mounted = {
      registered: appPresentation() === presentation,
      main: target.querySelectorAll("#main").length,
      map: target.querySelectorAll("#map").length,
      sheet: target.querySelectorAll("#alternatives-dialog").length,
    };
    await unmount(root);
    cycles.push({ mounted, disposals, remaining: target.childElementCount });
  }
  return cycles;
}
