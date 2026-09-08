const stages = [
  { title: 'Aufsteigen.\nOrientierung inklusive.', copy: 'Karte, Abbiegehinweise, Sprache und Haptik begleiten deine Radetappe. Bei wiederholter Abweichung wird die Route neu geplant.', foot: 'Navigation bis zum nächsten Wechsel', color: 'var(--cyan)' },
  { title: 'Kleiner Handgriff.\nFest eingeplant.', copy: 'Dein Rad braucht einen Moment. FoldRoute berücksichtigt deine eingestellte Faltzeit und den Fußweg zur Bahn. Du legst fest, wie viel Zeit du zum Falten brauchst.', foot: 'Faltzeit individuell einstellbar', color: 'var(--yellow)' },
  { title: 'Einsteigen.\nDen Anschluss im Blick.', copy: 'Linie, Richtung und verfügbare Gleisinformationen begleiten deine ÖPNV-Etappe. Zeitwarnungen und lokale Erinnerungen helfen dir beim nächsten Wechsel.', foot: 'Verbindungsdaten von Transitous / MOTIS', color: '#bdb5ff' },
  { title: 'Wieder aufs Rad.\nBis ganz ans Ziel.', copy: 'Nach der Bahn berücksichtigt FoldRoute deine eingestellte Entfaltzeit. Danach geht es auf der nächsten Etappe weiter – mit dem Rad oder zu Fuß bis zu deinem Ziel.', foot: 'Entfaltzeit individuell einstellbar', color: 'var(--cyan)' },
];

const buttons = document.querySelectorAll('[data-step]');
const symbol = document.getElementById('guidance-symbol');
const title = document.getElementById('guidance-title');
const copy = document.getElementById('guidance-copy');
const foot = document.getElementById('guidance-foot');

for (const button of buttons) {
  button.addEventListener('click', () => {
    const stage = stages[Number(button.dataset.step)];
    for (const item of buttons) {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    }
    symbol.replaceChildren(button.querySelector('.step-icon svg').cloneNode(true));
    symbol.style.color = stage.color;
    title.textContent = stage.title;
    title.style.whiteSpace = 'pre-line';
    copy.textContent = stage.copy;
    foot.textContent = stage.foot;
  });
}
