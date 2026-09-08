function openTopic() {
  const topic = document.getElementById(location.hash.slice(1));
  if (!topic) return;
  if (topic instanceof HTMLDetailsElement) topic.open = true;
  requestAnimationFrame(() => topic.scrollIntoView({ block: "start" }));
}
window.addEventListener("hashchange", openTopic);
openTopic();
