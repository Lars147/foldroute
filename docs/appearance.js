(() => {
  const key = "foldroute.appearance";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const normalize = (value) =>
    value === "light" || value === "dark" ? value : "system";
  let preference = "system";
  // Storage can be disabled by the browser; the theme still works for this visit.
  try {
    preference = normalize(localStorage.getItem(key));
  } catch {}

  function apply() {
    const theme =
      preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-canvas")
        .trim();
  }
  apply();
  media.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
})();
