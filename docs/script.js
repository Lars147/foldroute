const journey = document.querySelector('.journey-layout');
const steps = [...journey.querySelectorAll('[data-step]')];

function selectStep(selected) {
  for (const button of steps) {
    const expanded = button === selected;
    button.classList.toggle('active', expanded);
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-disabled', String(expanded));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
  }
}

for (const button of steps) {
  button.disabled = false;
  button.addEventListener('click', () => selectStep(button));
}
selectStep(steps[0]);
journey.classList.add('journey-ready');

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
