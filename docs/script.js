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
