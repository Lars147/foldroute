import { flushSync, mount, unmount } from "svelte";
import MapStylePicker from "./components/MapStylePicker.svelte";

const mounted = new WeakMap<HTMLElement, () => void>();

export function closeMapStylePickers() {
  document.querySelectorAll<HTMLElement>(".map-style-panel:popover-open")
    .forEach((panel) => panel.hidePopover());
}

/** Each host has exactly one owner; callers may dispose and mount it again. */
export function mountMapStylePicker(root: HTMLElement, id: string): () => void {
  const previous = mounted.get(root);
  if (previous) return previous;
  if (root.childElementCount) throw new Error("Map style host must be empty");
  const component = mount(MapStylePicker, { target: root, props: { id } });
  flushSync();
  const dispose = () => {
    if (mounted.get(root) !== dispose) return;
    mounted.delete(root);
    void unmount(component);
  };
  mounted.set(root, dispose);
  return dispose;
}
