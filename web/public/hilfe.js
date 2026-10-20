function openTopic() {
  const topic = document.getElementById(location.hash.slice(1));
  if (!topic) return;
  const answer = topic.closest("details") ?? topic.querySelector("details");
  if (answer) answer.open = true;
  requestAnimationFrame(() =>
    (answer ?? topic).scrollIntoView({ block: "start" }),
  );
}
window.addEventListener("hashchange", openTopic);
for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.addEventListener("click", () => {
    if (link.hash === location.hash) openTopic();
  });
}
openTopic();
