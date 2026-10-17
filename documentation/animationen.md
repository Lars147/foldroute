# Motion-Konzept für die FoldRoute-PWA

Stand: 17. Oktober 2026. Recherche, Bibliotheksvergleich und umgesetzter Vorschlag für die PWA.

## Umgesetzte Variante

Die PWA verwendet **CSS plus Motion Mini/Spring** als gemeinsame Bewegungssprache. Die bestehende Gestaltung mit gelber Auswahlmarkierung bleibt Grundlage; die Überarbeitung verbindet die Abläufe durch kurze, gerichtete Bewegung.

| Ablauf | Umgesetztes Verhalten |
| --- | --- |
| Hauptbereiche | Gemeinsamer gelber Tab-Indikator; kurze Einblendung des eingehenden Bereichs. |
| Verbindungsliste und Reiseablauf | Gerichteter kurzer Übergang; Zurück kehrt die Richtung um. Auswahl, Fokus und History bleiben unabhängig von der Animation. |
| Karte | Zusammenfassung erscheint ruhig innerhalb des Panels; die Kartenfläche selbst wird nicht verschoben oder ausgeblendet. |
| Routenauswahl und erste Ergebnisse | Bewusste Auswahl bekommt eine dezente Rückmeldung, erste Ergebnisse eine einmalige Einblendung. Hintergrundupdates starten keine Karten-Cascade. |
| Einstellungen | Aufgeklappte Inhalte blenden kurz ein; Chevron und Schalter reagieren konsistent. Eine volle gelbe Auswahlfläche gleitet zwischen System, Hell und Dunkel. |
| Dialoge und Kartenstile | Ruhigere Eintritte und kürzere Austritte über native CSS-Transitions mit `@starting-style`, `display` und `overlay`. Native Schließ-, Escape- und Fokussemantik bleibt unmittelbar. |
| Suche und Zeitwahl | Suchvorschläge erscheinen als gemeinsamer Bereich, ohne gestaffelte Treffer. Zeitbearbeitung und Monatswechsel zeigen ihre Richtung. |
| Zwischenziele und Verlauf | Vorhandene Zeilen gleiten bei bewussten Änderungen an ihre neue Position; neue Zeilen erscheinen kurz. Bestehendes Wischen im Verlauf bleibt erhalten. |
| Toasts, Undo und PWA-Hinweise | Kleine, kurze Einblendung; verfügbare Aktionen und Lesefristen werden nicht verzögert. |
| Aktive Navigation | Das untere Panel rastet beim Öffnen und Schließen sanft ein, auch beim Öffnen über einen Abschnitts-Tab. Bewusst gewählte Detailabschnitte wechseln kurz. Fahranweisung, GPS, Warnungen und Countdown aktualisieren unmittelbar. |

### Aktuelle Zeitabstimmung

Die zunächst sehr kurzen Übergänge wurden für eine ruhigere Standarddarstellung abgestimmt. Die Werte sind eigene Startwerte für FoldRoute. Größe und Bewegungsweg bestimmen die Dauer; diese Unterscheidung folgt den Empfehlungen von [Fluent](https://fluent2.microsoft.design/motion) und [IBM Carbon](https://www.carbondesignsystem.com/building-blocks/foundations/motion/overview).

| Ablauf | Dauer |
| --- | ---: |
| Tastendruck und Suchvorschläge | 120 ms |
| Tab-Indikator, Auswahl, Monats-/Detailabschnittswechsel, Schalter und Chevrons | 220 ms |
| Ansichtswechsel, sonstige Einblendungen, Dialog-/Desktop-Kartenstil-Eintritt | 300 ms |
| Mobiler Kartenstil-Eintritt, Navigationspanel-Eintritt und Zeilenbewegungen | 360 ms |
| Dialoge und Panels schließen | 240 ms |

Normale CSS- und JavaScript-Übergänge verwenden `cubic-bezier(0.2, 0, 0.38, 0.9)`. Dialoge und Kartenstil-Menü nutzen beim Eintritt `(0, 0, 0.38, 0.9)` und beim Austritt `(0.2, 0, 1, 0.9)`. Dialog und Hintergrund haben je Richtung dieselbe Dauer und Kurve. Bestehende Federanimationen behalten `bounce: 0`; ihre Dauer folgt den gemeinsamen Zeitwerten. Der native Zustand und Fokus ändern sich weiterhin unmittelbar, laufende Bewegung bleibt abbrechbar und Reduced Motion wird berücksichtigt.

Die Darstellungswahl verwendet für ihre volle gelbe Auswahlfläche 220 ms ohne Überschwingen. Schnelle Folgeaktionen starten an der aktuell sichtbaren Position. Die Farbpalette wechselt unmittelbar; die Auswahlfläche folgt der gewählten Präferenz auch dann, wenn System und explizite Darstellung dieselbe Palette ergeben. Erstes Anzeigen, Wiederöffnen und Größenänderungen positionieren die Fläche direkt. Ihre dunkle Beschriftung bleibt während der Bewegung an derselben Stelle wie die nativen Labels; die Fläche deckt jeweils nur den passenden Ausschnitt ab. Native Radio-Bedienung bleibt erhalten, Tastaturfokus wird auch beim Pfeiltastenwechsel in WebKit durch eine Unterstreichung sichtbar. Große Schrift und das vertikale Layout nutzen die tatsächlich gemessenen Segmentgrößen; Reduced Motion und fehlende Web Animations API führen unmittelbar zur Zielposition.

Die zentrale Implementierung liegt in [motion.ts](../web/src/motion.ts). Sie entfernt temporäre Inline-Stile nach Ende oder Abbruch und beendet laufende Bewegung bei Reduced Motion, App-Wechsel oder Fokus in einem bewegten Eingabebereich. Ohne Web Animations API bleiben alle Zustandswechsel nutzbar. CSS respektiert die Präferenz einschließlich Pseudoelementen. Die Navigationskamera berechnet ihren verfügbaren Platz anhand der endgültigen Panelposition, unabhängig von dessen sichtbarer Bewegung.

Der Produktionsbuild enthält gegenüber `0237352` insgesamt **6,90 KiB mehr JavaScript und 0,80 KiB mehr CSS, jeweils gzip**. Dafür wurden alle Dateien unter `docs/plan/assets` einzeln mit identischen gzip-Einstellungen komprimiert und summiert. Diese Messung umfasst die App-Integration; die weiter unten aufgeführten Bibliotheksmessungen sind isolierte Importbeispiele.

### Prüfung der Umsetzung

`npm run build` und alle **348 Unit-Tests** bestehen. Die **vollständige Browser-Suite nach dem unabhängigen Review, vor der anschließenden Popover-Korrektur**, ergab **813 bestandene Fälle und einen vorhandenen übersprungenen WebKit-Touch-Fall**. Zusätzlich bestehen alle 32 gezielten Review-Nachprüfungen in Chromium und WebKit.

Die anschließende Korrektur des Kartenstil-Menüs hält dessen Spaltenlayout auch während des Schließens aufrecht. Der neue Regressionstest reproduzierte davor in Chromium einen Höhensprung um 490 px. Nach der Korrektur bestehen **50 gezielte Browserfälle** für Kartenstile und aktive Navigation sowie erneut Build und alle 348 Unit-Tests. Die Tests pausieren in Chromium die tatsächlichen Austrittsübergänge bei 0, 50 und 95 Prozent und erlauben höchstens 1 CSS-Pixel Größenabweichung. Sie prüfen Mobil/Desktop, Schließen über Kreuz, Escape, Außenklick und Auslöser, schnelles Wiederöffnen sowie Reduced Motion. WebKit unterstützt in der getesteten Version die CSS-Eigenschaft `overlay` nicht; dort wird das native unmittelbare Schließen geprüft.

Nach der ruhigeren Zeitabstimmung bestehen **106 gezielte Browserfälle in Chromium und WebKit**: 78 für Motion, Kartenstile und Zeitwahl sowie 28 für Navigation, Dialogfokus und Zwischenziele. Build und alle 348 Unit-Tests wurden ebenfalls erneut erfolgreich ausgeführt. Die Kartenstil-Tests prüfen zusätzlich an den tatsächlichen Transitions, dass alle Austrittsspuren dieselbe Dauer haben und ein vollständiges Schließen kürzer dauert als das Öffnen. In der mobilen Vorschau wurden 360/240 ms für das Kartenstil-Menü sowie synchronisierte 300/240 ms für Dialog und Hintergrund bestätigt; Mobil-/Desktop-Darstellungen wurden visuell geprüft.

Für den gleitenden Auswahlrahmen bestehen anschließend **54 Browserfälle in Chromium und WebKit**, einschließlich zwölf neuer Prüfungen für tatsächliche Zwischenpositionen, schnelle Richtungswechsel, gleiche effektive Farbpalette, Tastaturfokus, gespeicherte Auswahl, Wiederöffnen, Größenänderungen, Reduced Motion und externe Speicheränderungen ohne Web Animations API. Bestehende Darstellungs-, Kontrast-, Speicher- und Motion-Prüfungen bleiben grün. Build, alle 348 Unit-Tests, Formatprüfung und `git diff --check` wurden erneut erfolgreich ausgeführt.

Nach dem Wechsel zur vollen gelben Auswahlfläche bestehen erneut alle 54 Browserfälle und 348 Unit-Tests sowie der Produktionsbuild. Die Bewegungstests prüfen zusätzlich die stationäre Beschriftung bei 0, 25, 50, 95 und 100 Prozent mit höchstens 1 CSS-Pixel Abweichung, mindestens 4,5:1 Textkontrast auf Gelb sowie Tastatur-Unterstreichung ohne zusätzlichen Auswahlrand. Helle und dunkle Darstellungen wurden visuell geprüft.

Die Prüfung umfasst Dialog-Endpositionen und schnelles Wiederöffnen, Navigationsfortschritt und Fokus, dynamisches Reduced Motion, große Schrift, den stabilen Startbutton sowie Suche und Bildschirmtastatur. Geometriemessungen warten die tatsächliche Animation ab; die App selbst bekommt dadurch keine Wartezeit. Veraltete Farb-/Fokuserwartungen wurden mit unverändertem `main` abgeglichen.

Mobil und Desktop wurden zusätzlich visuell mit hellem und dunklem Erscheinungsbild geprüft, einschließlich Liste, Reiseablauf, Karte, Einstellungen, Zeitwahl und kompaktem/offenem Navigationspanel. Eine Performance-Aufzeichnung auf einem physischen iOS-/Android-Gerät liegt noch nicht vor.

### Unabhängiger Review

Drei Agenten prüften Motion-Kern und Einbindungen, Dialoge/Navigation sowie Tests/Regressionen getrennt. Ein bestätigter Fehler mittlerer Priorität wurde korrigiert: Nach dem Hochsortieren eines Zwischenziels konnte dessen fokussierter Button durch die laufende Positionsanimation aus dem sichtbaren Scrollbereich gleiten. Die fokussierte Zeile nimmt jetzt vor der Fokus-/Scrollberechnung ihre endgültige Position ein; die übrigen Zeilen animieren weiter. Der Regressionstest scheitert ohne Korrektur und besteht mit ihr in Chromium und WebKit.

Drei Motion-Tests wurden auf tatsächliche Animationsphasen verschärft: Reduced Motion muss eine pausierte Animation abbrechen, schnelle Tabwechsel müssen eine bereits laufende Feder ersetzen, und deaktivierte Aktionen behalten ihre reduzierte Deckkraft auch während der Einblendung. Ein weiterer Test hält das Navigationspanel während seiner Bewegung an und prüft, dass Kamera und Kartensteuerung bereits die endgültige Panelgeometrie verwenden. Alle 32 gezielten Review-Nachprüfungen bestehen. Ein bereits auf unverändertem `main` reproduzierbarer Großschrift-Test scrollt nun den zu prüfenden Verspätungshinweis selbst ins Bild. Nach Prüfung der Korrekturen bleiben keine weiteren belegten Produktfehler aus den drei Reviews offen.

Ein aufwendiger gemeinsamer Elementübergang zwischen Routenkarte und Detailkopf sowie eine vollständig fingergeführte Expansion der Navigationsdetails bleiben optionale spätere Varianten. Dafür wird aktuell keine zusätzliche Layout- oder Drag-Engine geladen.

Die folgenden Abschnitte bewahren die Recherche und die ursprünglichen Entwurfsentscheidungen. Der Abschnitt oben beschreibt den tatsächlich umgesetzten Umfang.

FoldRoute profitiert am stärksten von einer zusammenhängenden Bewegungssprache für **Verbindungsliste, Reiseablauf, Karte und Navigationsdetails**. Kurze, nachvollziehbare Übergänge können die Oberfläche hochwertiger wirken lassen und zeigen, woher eine Ansicht kommt und wohin sie zurückführt. Der tatsächliche Nutzen muss anschließend an diesen Abläufen geprüft werden; eine pauschale Verbesserung durch mehr Animationen lässt sich aus den Quellen nicht ableiten.

## Gestaltungsrichtung

Die App unterstützt Menschen unterwegs: Ziel auswählen, Verbindung vergleichen, Faltrad und ÖPNV kombinieren, Fahranweisung erkennen. Dazu passt ruhige, präzise Bewegung. Eine Aktion bekommt eine erkennbare Antwort; regelmäßig aktualisierte Reiseinformationen bleiben stabil.

Apple empfiehlt gezielte, kurze, erwartbare und abbrechbare Bewegung. Ein- und Ausblenden sollen räumlich zusammenpassen; häufige Interaktionen sollen keine unnötigen Animationspausen verursachen. Daraus folgt für FoldRoute: wenige konsistente Muster verwenden und jede Animation an eine konkrete Nutzerabsicht binden. [Apple Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)

Bestehende Farben, Schrift und Flächen bleiben die Grundlage. Gelb markiert weiterhin die Auswahl; eine bewegte Auswahlfläche kann diese Bedeutung verstärken. Großflächige Zooms, federnde Reiselisten, Parallax und dauerhaft pulsierende Standortmarker passen weniger gut zum schnellen Erfassen unterwegs. Das ist eine gestalterische Empfehlung für dieses Produkt.

## Befund vor der Umsetzung

Geprüft wurden der aktuelle Quellcode, der vorhandene gebaute Beispielablauf bei 390 × 844 px und eine unabhängige UX-Einschätzung eines zweiten Agenten.

| Bereich | Aktueller Befund | Konsequenz |
| --- | --- | --- |
| Stack | Vite und TypeScript ohne UI-Framework; Leaflet für die Routenübersicht, OpenLayers für aktive Navigation | Native CSS- und Browseranimationen passen direkt zum Bestand. |
| Hauptbereiche | `show()` in [main.ts](../web/src/main.ts) schaltet Suche/Route, Strecken und Einstellungen über `hidden` um | Gleichrangige Bereiche brauchen eine andere Bewegung als der Schritt von Liste zu Detail. |
| Reiseansichten | `JourneyView.showScreen()` und `applyLayout()` in [journey-view.ts](../web/src/journey-view.ts) erhalten Fokus, Auswahl und Scrollposition | Diese vorhandene Kontinuität ist wichtiger als der Effekt und muss erhalten bleiben. |
| Ergebnisupdates | `JourneyView.render()` ersetzt die Verbindungskarten in `#choices` bei relevanten Änderungen über `replaceChildren()` | Eine allgemeine Entrance-Animation an jeder Karte würde auch beim Nachladen oder Aktualisieren neu starten. |
| Aktive Navigation | `NavigationView.setDetails()` und `layout()` in [navigation-ui.ts](../web/src/navigation-ui.ts) öffnen/schließen Details unmittelbar | Ein kurzer, bewusster Panel-Übergang ist sinnvoll. Laufende Fahrhinweise sollten unverzüglich erscheinen. |
| Navigationskarte | [navigation-map.ts](../web/src/navigation-map.ts) beobachtet Header und Panel mit `ResizeObserver` und zentriert relativ zur sichtbaren Fläche | Animierte Panelhöhe könnte gleichzeitig laufende Kameraverschiebungen auslösen. |
| Vorhandene Motion | [style.css](../web/src/style.css): Kartenstil-Popover mit 250 ms, Ladeindikator und Swipe-Transition; [history-swipe.ts](../web/src/history-swipe.ts): direkt geführte Wischgeste mit verzögertem Rendern während der Geste | Vorhandene Interaktionen harmonisieren und deren Gestenbehandlung erhalten. |
| Reduced Motion | Globale Regel schaltet CSS-Transitions und Smooth Scroll aus; einzelne Keyframes sind separat abgesichert | Neue Keyframes, JavaScript-Animationen und View Transitions brauchen ebenfalls eine explizite Behandlung. |

Im Rahmen der ursprünglichen Recherche wurden Verbindungsliste, geöffneter Reiseablauf, Kartenansicht und der jeweils gesetzte Fokus über den Accessibility-Baum bestätigt. Die aktive Routenführung wurde zunächst im Code untersucht. Damals wurden keine neuen Animationen oder deren Bildrate gemessen; die folgenden Werte wurden als Entwurfswerte gewählt. Die spätere Umsetzung ist oben beschrieben.

## Konkrete Animationen nach Priorität

Alle Zeit- und Wegangaben sind eigene Startwerte für FoldRoute, keine vorgeschriebenen Plattformwerte. Animationen starten ohne künstliche Verzögerung.

| Priorität | Aktion | Empfohlene Bewegung | Integrationspunkt / Aufwand |
| --- | --- | --- | --- |
| 1 | Verbindungsliste öffnet Details; zurück zur Liste | Neuer Inhalt bewegt sich etwa 16–20 px von rechts ein, alter Inhalt verschwindet kurz nach links. Zurück kehrt die Richtung um. Etwa 200–220 ms; Kopf und Aktionen bleiben ruhig. | `JourneyView.showScreen()`, `restoreNavigation()`, `applyLayout()`; mittel, wegen Fokus/History/Scrollposition. |
| 1 | Karte öffnen oder verlassen | Das Textpanel wechselt nachvollziehbar in die kompakte Zusammenfassung, etwa 220–260 ms. Route, Marker und Kartenausschnitt bleiben erhalten. Auf Desktop bleibt die gemeinsame Seitenleiste stehen; dort kein mobiler Vollbild-Slide. | `JourneyView` und Kartenlayout; mittel bis hoch, gemeinsam mit Größenberechnung prototypisieren. |
| 1 | Route / Strecken / Einstellungen wechseln | Eine gemeinsame gelbe Auswahlfläche gleitet zwischen den Tab-Symbolen, etwa 160–180 ms. Inhalt wechselt mit kurzer Überblendung um 120 ms. | `.app-tabs`, `main.ts:show()`; gering bis mittel. Keine zusätzliche Hierarchierichtung für gleichrangige Ziele. |
| 1 | Andere Verbindung auswählen | Auswahlfläche und Rahmen reagieren in 120–160 ms, ohne Größe oder Listenposition zu ändern. Daten der gewählten Route erscheinen sofort. | `.route-choice-row.selected`, `JourneyView.render()`; mittel, weil aktuell neue DOM-Knoten entstehen. |
| 1 | Reisedetails während der Navigation auf-/zuklappen | Unteres Panel öffnet/schließt in etwa 220–260 ms, Chevron dreht passend mit. Kein Nachfedern. Fahranweisung oben bleibt sichtbar. | `NavigationView.setDetails()/layout()` und `NavigationMap.position()`; höherer Integrationsaufwand wegen Kamerageometrie. |
| 2 | Routenbearbeitung, weitere Aktionen, Bestätigung öffnen | Mobile Panels kommen aus ihrer tatsächlichen unteren Position; auf Desktop reichen Opacity und etwa 6–8 px Bewegung. Öffnen etwa 180–220 ms, Schließen etwas kürzer. | Dialoge in `main.ts`, `JourneyView` und `NavigationView`; mittel, wegen Fokus, Escape und Bildschirmtastatur. |
| 2 | Verlaufseintrag löschen / rückgängig machen | Nach bestätigtem Löschen rücken benachbarte Einträge kurz zusammen. Undo-Hinweis erscheint mit Opacity und etwa 6 px Weg. | `historyUI()`, [history-undo.ts](../web/src/history-undo.ts); mittel. Bestehende acht Sekunden und Pausen bei Hover/Fokus erhalten. |
| 2 | Zwischenziel hinzufügen oder verschieben | Bereits vorhandene Zeilen wechseln in etwa 180–220 ms nachvollziehbar ihre Position. Vorher-/Nachher-Positionen messen und die Differenz über `transform` abbauen. | `StopEditor.move()/layout()` in [stop-editor.ts](../web/src/stop-editor.ts); mittel. IDs und Tastaturfokus erhalten. |

Besonders wertvoll als späterer Feinschliff ist ein gemeinsames Element zwischen ausgewählter Verbindung und Detailkopf: etwa dieselbe Zusammenfassung von Dauer und Verkehrsmitteln. Es erklärt den Zusammenhang besser als eine spektakuläre Ganzseitenanimation. Zunächst nur diesen kleinen Bereich prototypisieren; unterschiedliche Textumbrüche dürfen während der Bewegung nicht verzerren.

Die bereits fingergeführte Verlaufsgeste ist ein gutes Vorbild für Natürlichkeit: Während des Ziehens folgt das Element unmittelbar dem Finger. Easing gehört in das anschließende Einrasten. Die Navigationsleiste erkennt ihre Wischrichtung derzeit erst beim Loslassen; eine vollständig fingergeführte Expansion wäre eine spätere Ausbaustufe.

## Suche, Laden und laufende Routenführung

Bei neuer Zielsuche erscheint die erste nutzbare Ergebnisliste sofort. Eine einmalige kurze Einblendung des Ergebnisbereichs kann den Zustandswechsel zeigen. Weitere Alternativen und Echtzeitantworten spielen diese Animation nicht erneut ab. Suchvorschläge müssen beim Tippen unverzüglich bedienbar sein; keine gestaffelte Einflugsequenz.

Beim Aktualisieren bleiben vorhandene Verbindungen mit dem bestehenden Statushinweis sichtbar. Keine erfundene Prozentanzeige und keine künstliche Mindestladezeit einführen. Ein Ladeindikator darf Aktivität zeigen, muss unter Reduced Motion durch verständlichen statischen Statustext ergänzt oder ersetzt werden.

Für aktive Navigation gilt als Produktentscheidung:

- Entfernung, Ankunft, Countdown und aktuelle Fahranweisung direkt aktualisieren. Keine rollenden Ziffern oder ausgeblendeten Zwischenphasen.
- Warnungen und neue kritische Informationen sofort lesbar machen. Animation darf ihre Verfügbarkeit nicht verzögern.
- Bewegung auf bewusst geöffnete Details, gewählte Reiseabschnitte und Bestätigungen konzentrieren.
- Keine dekorative Kamera-Rundfahrt beim Start, keine ständig neu gezeichnete Route und kein permanenter Standortpuls.
- Falls später Kamerainterpolation gewünscht ist: als eigenes Navigationsverhalten behandeln, mit GPS-Qualität, Gestenunterbrechung, Heading-Wechseln und Reduced Motion prüfen.

## Technikempfehlung

**Erste Stufe: CSS für Zustände, Web Animations API für gesteuerte Übergänge.** Eine kleine gemeinsame Motion-Schicht kann Zeiten, Easing, Reduced Motion und laufende Animationen verwalten. Sie ist eine Darstellungsschicht; Routing, gespeicherte Daten und Navigation bleiben unabhängig von ihrer Laufzeit.

CSS-Transitions passen zu Tab-Indikator, Auswahlfläche und Chevron. `Element.animate()` passt zu Ein-/Ausblenden und Positionswechseln, die gezielt ausgelöst und unterbrochen werden müssen. Beim Abbruch entfernt `Animation.cancel()` die Animationseffekte; ein bereits beobachtetes `finished`-Promise kann dabei mit `AbortError` ablehnen. Erwartete Abbrüche daher gezielt behandeln, echte Fehler sichtbar lassen. [MDN: Animation.cancel()](https://developer.mozilla.org/en-US/docs/Web/API/Animation/cancel)

**View Transitions als gezielte Ergänzung prototypisieren.** `document.startViewTransition()` unterstützt Übergänge zwischen DOM-Zuständen und einen direkten Fallback ohne Animation. MDN führt die Methode seit Oktober 2025 als Baseline; ältere Geräte und Browser bleiben zu berücksichtigen. Der Nachweis für die Document-Methode gilt nicht automatisch für neuere Teilfunktionen wie elementbezogene Transitions. [MDN: Document.startViewTransition()](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition)

Für Liste/Detail kann die API gerade wegen der DOM-Ersetzung hilfreich sein. Dabei nur gewünschte Bereiche erfassen: `view-transition-name: none` an der Karte allein schließt sie nicht aus dem Snapshot eines übergeordneten Elements aus. Root-Aufnahme und benannte Panels bewusst konfigurieren; eindeutige Namen, Kartenrendering, Dialog-Layer und Pointer-Verhalten prüfen. Bei instabilen Ergebnissen ist ein direkter Panel-Übergang vorzuziehen. [MDN: Using the View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using)

**Für die Bibliotheksvariante ist Motion für JavaScript gewählt.** Kleine Panelbewegungen und natürliches Einrasten verwenden `motion/mini` mit gezielt importierter Spring-Funktion. Für komplexere Layoutübergänge bleibt der größere Funktionsumfang eine separate Option. Ein Wechsel zu React ist dafür nicht nötig. Einfache Zustandswechsel verwenden weiterhin CSS. Der folgende Vergleich begründet die Entscheidung. [Motion: JavaScript Quick Start](https://motion.dev/docs/quick-start)

## Vergleich der Animationsbibliotheken

Ergänzt am 16. Oktober 2026. Geprüft wurden aktuelle Dokumentation, veröffentlichte Paketversionen und isoliert gebündelte Beispiele. Die Bewertung bezieht sich auf FoldRoutes bestehenden Vanilla-TypeScript-Stack und ist keine allgemeine Rangliste.

| Bibliothek | Stärken für FoldRoute | Grenze / Bewertung |
| --- | --- | --- |
| **Motion für JavaScript 14.3.0** | Springs für Panels und Auswahlindikator; kleine Mini-Variante; Hybrid für unabhängig animierte Transform-Achsen und Sequenzen | **Favorit für gezielte UI-Bewegung.** Mini ist keine automatische Layout- oder Drag-Lösung. Nur benötigte APIs importieren. |
| **Anime.js 4.5.0** | Springs, Timelines, `createDraggable()` und `createLayout()` direkt in JavaScript | **Starke Alternative**, besonders bei später vollständig fingergeführten Panels oder umfangreicheren SVG-Animationen. Mehr Funktionsumfang als für erste kurze Ansichtswechsel erforderlich. |
| **GSAP 3.15.0** | Präzise Timelines, Flip für Layoutwechsel, separate Draggable-Werkzeuge und gutes Cleanup über Context/MatchMedia | **Passend bei komplexer Choreografie.** Für den jetzigen Kernablauf höherer Umfang; bringt den größten Mehrwert, wenn viele koordinierte Abläufe gebraucht werden. |
| **AutoAnimate 0.10.0** | Sehr wenig Integrationscode für Einfügen, Entfernen und Umsortieren direkter Kindknoten | **Selektiv einsetzen.** Für Zwischenziele interessant; nicht pauschal an `#choices` hängen, weil FoldRoute dessen Kinder auch bei Datenupdates neu erzeugt. |

Die Funktionsunterschiede sind durch die jeweiligen Primärquellen belegt: [Motion animate](https://motion.dev/docs/animate), [Anime.js Layout](https://animejs.com/documentation/layout/), [Anime.js Draggable](https://animejs.com/documentation/draggable/), [GSAP Flip](https://gsap.com/docs/v3/Plugins/Flip/) und [AutoAnimate](https://auto-animate.formkit.com/). Die Priorisierung ist aus FoldRoutes Code und den vorgeschlagenen Abläufen abgeleitet.

### Was Motion konkret abdecken würde

- **Mini + Spring:** Tab-Indikator, kurze Panelbewegung und Einrasten nach einer vorhandenen Pointer-Geste. Mini animiert CSS-Transform-Strings; unabhängige `x`-/`y`-Steuerung und Sequenzen gehören zur Hybrid-Variante. [Motion: animate](https://motion.dev/docs/animate)
- **Layout-API:** `animateLayout()` kann seit Motion 14.1 auch ohne React Layoutänderungen animieren. `data-layout-id` verbindet visuell zusammengehörige Elemente, etwa eine Routenkarte und ihre Detailzusammenfassung. Die Dokumentation nennt jedoch Grenzen für den Rückweg beim Crossfade: Eine Vanilla-JS-Entsprechung zu Reacts `AnimatePresence` fehlt noch. Deshalb beide Richtungen prototypisieren und keine vollständige React-Funktionsparität voraussetzen. [Motion: Layout animations](https://motion.dev/docs/layout-animations)
- **Gesten:** Die JavaScript-API besitzt unter anderem `press()` mit Tastaturunterstützung. Daraus folgt nicht automatisch Reacts `drag`-Komponente für die PWA. Die vorhandene `HistorySwipe`-Logik erhalten; eine neue Panel-Ziehgeste bewusst selbst führen oder Anime.js/GSAP-Draggable dafür evaluieren. [Motion: press](https://motion.dev/docs/press)

Keine dieser Bibliotheken ersetzt History, Fokusführung, `hidden`/`inert`, Scrollwiederherstellung oder die Abstimmung zwischen Panel und Kartenkamera. Diese Regeln bleiben in FoldRoutes Darstellungsschicht.

### Gemessener Bundle-Umfang

Pakete wurden ausschließlich in einem temporären Verzeichnis installiert. Projektabhängigkeiten und Lockfile blieben unverändert. Messung: esbuild 0.28.2, Browser-ESM, Ziel ES2020, Minifizierung und Tree Shaking; gzip Stufe 9, ohne Lizenzkommentare. Jede Zeile ist ein eigenständig gebauter Einstieg mit einer exportierten aufrufbaren Funktion. Die konkreten Versionen, Optionen, Eingaben und Bytewerte stehen in [den Messdaten](animation-library-bundles.json).

| Isolierter Einstieg | Minifiziert | gzip |
| --- | ---: | ---: |
| Native Web Animations API, nur Aufrufcode | 0,1 KiB | 0,1 KiB |
| Motion Mini, Panel mit Transform/Opacity | 8,3 KiB | 3,3 KiB |
| **Motion Mini + Spring** | **12,4 KiB** | **5,0 KiB** |
| Motion Hybrid + Spring | 63,2 KiB | 23,6 KiB |
| Motion `animateLayout` | 101,6 KiB | 34,0 KiB |
| Anime.js Animate + Spring | 32,7 KiB | 13,1 KiB |
| Anime.js Layout | 57,8 KiB | 20,8 KiB |
| GSAP Core, Panelbewegung | 68,6 KiB | 26,8 KiB |
| GSAP + Flip | 92,7 KiB | 35,3 KiB |
| AutoAnimate, beobachteter Container | 7,7 KiB | 3,1 KiB |

1 KiB = 1024 Byte. Diese Werte vergleichen Downloadumfang ausgewählter Funktionen, nicht gleiche Funktionalität oder Laufzeitgeschwindigkeit. AutoAnimate beobachtet DOM-Änderungen, Layout-Engines messen Layouts, die Panelbeispiele animieren nur Transform/Opacity. Mehrere Zeilen derselben Bibliothek dürfen wegen geteilter Module nicht einfach addiert werden. Der reale Zusatz im Vite-Produktionsbuild kann anders ausfallen; eigene Reduced-Motion-/Integrationslogik ist in diesen Mini-Beispielen nicht enthalten. Die Pakete wurden erfolgreich gebündelt, ihre Animationen hier nicht im Browser ausgeführt.

### Reduced Motion, Lifecycle und Lizenz

Für Motion-JavaScript-Aufrufe bleibt eine zentrale `matchMedia`-Prüfung inklusive Änderungen während der Sitzung Teil der Integration; React-Hooks wie `useReducedMotion` sind für diese PWA keine Lösung. Anime.js bietet Media Queries in Scopes, GSAP `gsap.matchMedia()` mit Cleanup. Diese Mechanismen ermöglichen die Anpassung; das passende reduzierte Verhalten muss die App festlegen. [Anime.js: mediaQueries](https://animejs.com/documentation/scope/scope-parameters/mediaqueries/), [GSAP: matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/)

AutoAnimate respektiert Reduced Motion standardmäßig. Im geprüften Paket wird die Präferenz beim Einrichten abgefragt; für Änderungen während der Sitzung ist zusätzlich eigene Koordination nötig. Ein bei aktivem Reduced Motion übersprungener Setup wird durch bloßes `enable()` nicht nachträglich vollständig eingerichtet. Auch das vorübergehende Abschalten rund um Echtzeitupdates muss gegen die asynchrone MutationObserver-Verarbeitung geprüft werden. [AutoAnimate-Dokumentation](https://auto-animate.formkit.com/)

Die geprüften Pakete Motion, Anime.js und AutoAnimate nennen MIT als Lizenz. GSAP verwendet eine eigene [Standardlizenz](https://gsap.com/community/standard-license/). Kostenpflichtige Beispiel-/Editorangebote sind vom jeweiligen Bibliothekspaket zu unterscheiden; für den vorgeschlagenen Motion-Mini-Pilot werden sie nicht benötigt.

### Lottie und Rive einordnen

Lottie spielt gestaltete After-Effects-Animationen ab; Rive bietet interaktive Animationsdateien mit Zustandsmaschinen und eigener Web-Runtime. Sie können etwa eine kurze Faltrad-Illustration oder eine Erfolgsgrafik liefern. Für FoldRoutes vorhandene HTML-Panels und Ansichtswechsel würde ich sie nicht als Hauptwerkzeug einsetzen. Rive benötigt zusätzlich Animationsdatei und JS/WASM-Runtime; das ist ein anderer Anwendungsfall als der hier gemessene DOM-Bundle-Vergleich. [Lottie Web](https://github.com/airbnb/lottie-web), [Rive Web](https://rive.app/docs/runtimes/web/web-js)

### Entscheidung für einen Pilot

**CSS plus Motion Mini/Spring** für Tab-Indikator, Liste/Detail-Übergang und bewusstes Panel-Einrasten. Erst wenn der gemeinsame Übergang von Routenkarte zu Detailkopf einen klaren Mehrwert zeigt, Motion Layout ergänzen. Wenn der Schwerpunkt stattdessen auf umfangreichen Drag-Interaktionen liegt, Anime.js als zweite Option prototypisieren. Kein Mix aus mehreren kompletten Animationsengines für diese erste Stufe.

## Gemeinsame Motion-Werte

Vorschlag für spätere Tokens in `style.css` und die gemeinsame TypeScript-Schicht:

| Rolle | Startwert | Verwendung |
| --- | --- | --- |
| Direktes Feedback | 100–120 ms | Kleine Status-/Bedienreaktion |
| Auswahl | 150–180 ms | Verbindung und Tab-Indikator |
| Ansichtswechsel | 200–220 ms | Liste / Details |
| Größeres Panel | 240–260 ms | Navigationsdetails und mobile Overlays |
| Eintritt | `cubic-bezier(0.2, 0, 0, 1)` | Zügiger Beginn, sanftes Ankommen |
| Austritt | `cubic-bezier(0.4, 0, 1, 1)` | Kürzeres, zügiges Verlassen |
| Standardweg | 8–20 px | Kleine räumliche Hinweise; Sheets dürfen ihrem tatsächlichen Ursprung folgen |

Eine natürliche Wirkung entsteht hier aus gleichbleibender Richtung, passender Geschwindigkeit und direkter Reaktion. Spring-Physik ist optional. Wenn später eingesetzt, stark dämpfen und sichtbares Überschwingen bei Text und Fahrhinweisen vermeiden.

## Integrationsregeln

1. **Erst gültigen Wechsel bestimmen.** `show()` und `popstate` enthalten Settings-Validierung, History und Bestätigungen für aktive Navigation. Nur einen tatsächlich akzeptierten Wechsel animieren. An fehlgeschlagener Validierung bleibt die aktuelle Ansicht stehen.
2. **Zustand nicht an Animationsende koppeln.** Zielzustand und History gehören zum akzeptierten Wechsel. Fokus, ausgeblendete/inaktive Inhalte und Scrollwiederherstellung müssen auch bei übersprungener Bewegung korrekt sein. Visuelle Altzustände dürfen keine zweite bedienbare Oberfläche erzeugen.
3. **Schnelle Folgeaktionen zulassen.** Laufende Bewegung abbrechen oder sinnvoll neu ausrichten. Keine Animationswarteschlange und keine künstliche Klicksperre. Bereits vorgemerkte View-Transition-DOM-Updates dürfen bei einem neueren Wechsel keinen alten Zustand zurückbringen; Revisionsprüfung oder zusammengefasste Aktualisierung vorsehen. `skipTransition()` überspringt die Animation, führt aber das DOM-Update weiterhin aus. [MDN: ViewTransition.skipTransition()](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition/skipTransition)
4. **Updateursache unterscheiden.** Explizites Öffnen, Zurück, Auswahl, Wiederherstellung, Bildschirmgrößenwechsel und Echtzeitupdate sind unterschiedliche Ursachen. Keine Animation allein aufgrund neuer DOM-Knoten starten. Bei Wiederaufnahme, Breakpoint-Wechsel und Hintergrundupdates ist ein unmittelbarer Zustand oft passender.
5. **Karte und Panel gemeinsam planen.** Keine ungeprüfte `max-height`-Transition am Navigationspanel. Finale Geometrie und nötige Kamerakorrektur koordiniert berechnen; prüfen, dass ResizeObserver keine fortlaufende Neuzentrierung erzeugt. Auch `animate: false` an bestehenden Kartenaktionen nicht pauschal umschalten: Die Erkennung programmatischer Kamerabewegungen ist derzeit auf den synchronen Ablauf abgestimmt.
6. **Layoutarbeit begrenzen.** Für Bewegungen bevorzugt `transform` und `opacity`; animierte Breiten, Höhen, Schatten und Blur nur nach Messung einsetzen. Kleine Farbwechsel sind möglich, müssen aber kein komplexes Paint auslösen. `will-change` nicht pauschal auf jede Karte setzen. [web.dev: High-performance CSS animations](https://web.dev/articles/animations-guide)
7. **Reduced Motion vollständig unterstützen.** CSS-Transitions, Keyframes, Pseudoelemente, Web Animations und optionale Kamerabewegung berücksichtigen. Bei aktivierter Reduktion Zielzustand unmittelbar herstellen; bei geänderter Systemeinstellung laufende nicht notwendige Bewegung beenden. View Transitions benötigen eine explizite Regel für ihre Pseudoelemente oder werden gar nicht gestartet. [web.dev: View transitions for SPAs](https://web.dev/learn/css/view-transitions-spas)

Die Abschaltbarkeit nicht notwendiger Interaktionsanimationen ist außerdem Gegenstand von WCAG 2.3.3 auf Stufe AAA. Das ist eine sinnvolle Qualitätsleitlinie, aber keine Behauptung, sämtliche hier vorgeschlagenen Regeln seien zwingende AA-Anforderungen. Bedeutung muss zusätzlich über Text, Auswahlzustände und Semantik verständlich bleiben. [W3C: Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

## Sinnvolle Umsetzungsschritte

**Schritt 1: gemeinsamer Unterbau und sichtbarer Pilot.** Motion-Werte und Reduced-Motion-Verhalten zentralisieren. Danach Tab-Indikator, bewussten Wechsel Liste/Detail und Routenauswahl umsetzen. Browser-Zurück und schnelle Folgeaktionen direkt mit prüfen. Das ergibt früh einen durchgängigen Eindruck im Kernablauf.

**Schritt 2: Karte und Navigationspanel.** Die Kopplung von Panelgeometrie und Kamera zuerst isoliert prototypisieren. Anschließend bewusste Expansion, Chevron und passende Dialogbewegung ergänzen. Direkte Fahrhinweise und Warnungen bleiben sofort verfügbar.

**Schritt 3: kleine Abläufe vervollständigen.** Verlauf/Undo, Zwischenzielreihenfolge und einmaligen Ladeabschluss ergänzen. Danach Effekte entfernen, die nur bei der ersten Vorführung gefallen und wiederholte Benutzung verlangsamen.

## Prüfkriterien

Die vorhandenen Browserfälle in `journey-ux.spec.ts`, `overview-ux.spec.ts`, `settings-ux.spec.ts`, `navigation-ux.spec.ts`, `history-address-ux.spec.ts` und `example-ux.spec.ts` prüfen die bestehenden Abläufe. Ergänzend testet [motion-ux.spec.ts](../web/tests/browser/motion-ux.spec.ts) schnelle Unterbrechungen, Fokus und History, dynamisch geändertes Reduced Motion, Textskalierung und Resize, native Dialoge sowie den Fallback ohne `Element.animate`. Die folgenden Kriterien gelten auch für spätere Erweiterungen.

- Liste → Detail → Karte → Browser-Zurück: richtige Auswahl, tatsächliche History-Reihenfolge und gespeicherte Listenposition. Keine doppelte History durch Animation.
- Sehr schnelles Öffnen/Zurück und mehrfacher Tab-Wechsel: letzter gültiger Zustand gewinnt; kein verspätetes Ausblenden, verlorener Fokus oder unbehandelter Promise-Abbruch.
- Settings mit ungültiger Eingabe: abgelehnter Wechsel animiert nicht. Bestätigungsdialoge, Escape und Fokus-Rückgabe bleiben korrekt.
- Normale Bewegung, Reduced Motion bereits beim Start und Änderung während einer Animation: identische verfügbare Inhalte und Funktionen, jeweils passende Bewegung.
- Neue Ergebnisse, Auswahlwechsel und ÖPNV-/GPS-Updates getrennt prüfen: keine ständig wiederkehrende Entrance-Animation und kein Scrollsprung.
- Navigationsdetails öffnen/schließen, Standort-Folgen und manuelles Verschieben kombinieren: keine unerwartete Kamerafahrt oder verdeckte Fahranweisung.
- Touch, Tastatur, kleine Höhe, große Schrift, mobile Bildschirmtastatur, Hell/Dunkel und beide Seiten der 900-px-Grenze prüfen. Installed PWA auf iOS und Android zusätzlich am Gerät ansehen.
- Chromium und WebKit automatisiert prüfen; Fallback ohne View Transitions gezielt testen. Unterstützungsprüfungen ersetzen keinen visuellen Gerätetest.
- Auf repräsentativem Mobilgerät mit gleichzeitig laufender Karte Performance-Aufzeichnung prüfen: keine wiederkehrende Layoutarbeit je Animationsframe, auffälligen Frameverluste oder verzögerte Eingaben. Eine feste 60-fps-Zusage folgt aus `transform` allein nicht.

Für eine rein native erste Stufe entsteht kein zusätzliches Bibliotheksbudget. Die Bibliotheksvariante mit Motion Mini/Spring hat im isolierten Beispiel rund 5 KiB gzip; deren tatsächlichen Einfluss auf Produktionsbuild und Offline-Caching bei einer Implementierung erneut messen.

## Anschauliche Referenz

Die [interaktiven MDN-Beispiele für View Transitions](https://mdn.github.io/dom-examples/view-transitions/) zeigen, wie ein Objekt seinen Zusammenhang zwischen zwei Ansichten behalten kann. Für FoldRoute ist diese Kontinuität zwischen Verbindung und Reiseablauf die interessante Idee; Gestaltung und Effektausmaß müssen zum mobilen Reiseplaner passen.
