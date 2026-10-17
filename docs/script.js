const comparisonControls = document.querySelector('.comparison-controls');
comparisonControls.closest('.comparison-panel').classList.add('comparison-ready');
const comparisons = [...comparisonControls.querySelectorAll('[data-comparison]')];
const mobile = window.matchMedia('(max-width: 760px)');
let selectedComparison = 'foldroute';

function updateComparison() {
  comparisonControls.hidden = !mobile.matches;
  for (const button of comparisons) {
    const selected = button.dataset.comparison === selectedComparison;
    button.setAttribute('aria-pressed', String(selected));
    document.getElementById(button.getAttribute('aria-controls')).hidden = mobile.matches && !selected;
  }
}

for (const button of comparisons) {
  button.addEventListener('click', () => {
    selectedComparison = button.dataset.comparison;
    updateComparison();
  });
}
mobile.addEventListener('change', updateComparison);
updateComparison();

const preview = document.querySelector('.planner-preview');
const previewPanels = [...preview.querySelectorAll('figure')];
const previewAnnouncement = preview.querySelector('.preview-announcement');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let previewIndex = 0;
let announcementTimer;
let drag;

function previewPosition(index) {
  const panel = previewPanels[index];
  return panel.offsetLeft - (preview.clientWidth - panel.offsetWidth) / 2;
}

function nearestPreview() {
  return previewPanels.reduce((nearest, panel, index) =>
    Math.abs(previewPosition(index) - preview.scrollLeft) < Math.abs(previewPosition(nearest) - preview.scrollLeft)
      ? index : nearest, 0);
}

function showPreview(index) {
  const next = Math.max(0, Math.min(index, previewPanels.length - 1));
  preview.scrollTo({
    left: previewPosition(next),
    behavior: reducedMotion.matches ? 'instant' : 'smooth',
  });
}

preview.addEventListener('scroll', () => {
  clearTimeout(announcementTimer);
  announcementTimer = setTimeout(() => {
    previewIndex = nearestPreview();
    previewAnnouncement.textContent = previewPanels[previewIndex].getAttribute('aria-label');
  }, 120);
}, { passive: true });

preview.addEventListener('keydown', event => {
  const indices = { ArrowLeft: nearestPreview() - 1, ArrowRight: nearestPreview() + 1, Home: 0, End: previewPanels.length - 1 };
  if (!(event.key in indices)) return;
  event.preventDefault();
  showPreview(indices[event.key]);
});

// Touch and trackpad scrolling stay native. Only mouse dragging needs handling.
preview.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
  drag = { id: event.pointerId, x: event.clientX, left: preview.scrollLeft, index: nearestPreview() };
  preview.setPointerCapture(event.pointerId);
  preview.classList.add('is-dragging');
});
preview.addEventListener('pointermove', event => {
  if (drag?.id === event.pointerId)
    preview.scrollLeft = drag.left + drag.x - event.clientX;
});
function finishDrag(event) {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = drag.x - event.clientX;
  let next = nearestPreview();
  if (event.type === 'pointerup' && next === drag.index && Math.abs(dx) >= 48)
    next += dx > 0 ? 1 : -1;
  drag = undefined;
  preview.classList.remove('is-dragging');
  if (preview.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId);
  showPreview(next);
}
preview.addEventListener('pointerup', finishDrag);
preview.addEventListener('pointercancel', finishDrag);
preview.addEventListener('lostpointercapture', finishDrag);
new ResizeObserver(() => {
  if (!drag) preview.scrollTo({ left: previewPosition(previewIndex), behavior: 'instant' });
}).observe(preview);
