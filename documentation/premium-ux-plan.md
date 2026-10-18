# Premium-UX für FoldRoute Web/PWA

Status: Änderung 3 umgesetzt; Änderungen 1, 4, 5 und 6 geplant; Änderung 2 zurückgestellt · Stand: 18. Oktober 2026

## Ziel und Rahmen

FoldRoute soll während Planung und Reise mehr Orientierung, Kontrolle und Sicherheit vermitteln. Grundlage sind der gemeinsame UI-Vergleich und die sechs vom Nutzer angenommenen Verbesserungsvorschläge: verständliche Zustände und Rückwege, Konsistenz zwischen Ansichten und konkrete Hilfe bei Fehlern.

In diesem Worktree ist zunächst ausschließlich Änderung 3 umgesetzt. Änderung 2 ist auf Nutzerwunsch zurückgestellt; Änderungen 1, 4, 5 und 6 bleiben geplant. Die übrigen Abschnitte beschreiben die späteren Arbeiten.

- Nur Webplaner und PWA; keine Änderungen am iOS-Prototyp.
- Bestehende Gestaltung, Routingregeln, Datenschutz und lokale Speicherung als Grundlage erhalten.
- Keine neuen externen Dienste oder öffentlichen APIs einführen.
- Bestehende Fehlerhilfen und Undo-Funktionen weiterverwenden.
- Fremde oder uncommittete Änderungen anderer Worktrees nicht übernehmen oder verändern.

## 1. Löschschutz beim Ausschalten der Speicherung

**Beobachtung:** Der Schalter „Strecken auf diesem Gerät speichern“ löscht beim Ausschalten sofort den Verlauf und beendet die Undo-Möglichkeit. Die separate Aktion „Streckenverlauf löschen“ besitzt dagegen einen Bestätigungsdialog.

**Geplantes Verhalten:**

- Bei vorhandenem Verlauf vor dem Ausschalten einen Bestätigungsdialog anzeigen.
- Erklären, dass gespeicherte Strecken gelöscht werden und künftige Planungen nicht mehr gespeichert werden. Weitere tatsächlich betroffene Wiederaufnahmedaten ausdrücklich nennen.
- Aktionen: „Abbrechen“ und „Strecken löschen und ausschalten“. Erst nach Bestätigung Daten löschen und Speicherung ausschalten.
- Bei leerem Verlauf und ohne betroffene Wiederaufnahmedaten direkt ausschalten.
- Abbrechen oder Schließen des Dialogs erhält Schalterzustand, Daten und eine bestehende Undo-Möglichkeit. Bei Speicherfehlern tatsächlichen Zustand zeigen und Wiederholung ermöglichen.

Einstieg: [Speicherschalter](../web/src/main.ts) und [lokaler Verlauf](../web/src/offline.ts).

## 2. GPS-Probleme direkt handhabbar machen

**Status: Auf Nutzerwunsch zurückgestellt.**

**Beobachtung:** „Kein GPS“ und „GPS ungenau“ sind sichtbar; die Erklärung zum pausierten automatischen Fortschritt und die Standortaktion liegen im Detailbereich.

**Geplantes Verhalten:**

- Während aktiver Navigation „Kein GPS · Fortschritt pausiert“ beziehungsweise „GPS ungenau · Fortschritt pausiert“ sichtbar anzeigen.
- „Standort prüfen“ öffnet die vorhandenen Navigationsdetails und führt zur Standortmeldung mit passender Hilfe beziehungsweise bestehender Standortaktion.
- Das Öffnen der Hilfe löst selbst noch keine Standortabfrage aus. Ein erneuter Abruf bleibt eine ausdrückliche Nutzeraktion.
- Sobald ein aktueller, ausreichend genauer Standort vorliegt, Warnung entfernen und vorhandenes Fortschrittsverhalten wieder aufnehmen.
- Zielerreichung und andere Warnungen weiterhin korrekt behandeln; GPS-Hilfe darf bei eingeklappten Details nicht verschwinden.

Einstieg: [Navigationsoberfläche](../web/src/navigation-ui.ts).

## 3. Laufende Zusatzsuche verständlich erklären

**Beobachtung:** Erste Ergebnisse erscheinen vor Abschluss der Optimierung. Ein fortlaufender Spinner und eine sichtbare Stoppaktion lassen bereits nutzbare Verbindungen weiterhin unfertig wirken.

**Status: Umgesetzt.**

**Umgesetztes Verhalten:**

- Erste Routensuche, laufende Zusatzsuche, vollständigen Abschluss und teilweise abgeschlossene Suche unterscheiden. Basissuche, Rad-Umstiege, Fußwegoptimierung und Zwischenzielsuche melden ihre tatsächliche Phase vor Beginn der jeweiligen Anfragen.
- Vor ersten aktuellen Ergebnissen zeigt ein Toast mit Spinner „Verbindungen werden gesucht …“ beziehungsweise den Standorthinweis. Er bleibt bis zu Ergebnissen oder einem Fehler sichtbar. Sobald aktuelle Ergebnisse nutzbar sind, wechselt er einmal pro Berechnung für drei Sekunden zu „Verbindungen gefunden“ mit Haken. Ein dünner, schrumpfender Zeitbalken zeigt bei automatisch ausblendenden Meldungen die verbleibende Dauer: drei Sekunden für diese Bestätigung, sechs Sekunden für andere temporäre Toasts. Dauerhafte Such- und Optimierungshinweise sowie Teilfehler erhalten keinen Zeitbalken; bei reduzierter Bewegung bleibt er ausgeblendet. Läuft die Zusatzsuche danach noch, erscheint an derselben Stelle „Optimierung läuft …“ mit Spinner. Bei Abschluss verschwindet der Toast. Keine dauerhafte Bereitschaftszeile und keine Meldungen für jede neue Alternative anzeigen.
- Desktop-Toasts stehen oben mittig in der freien Kartenfläche zwischen Seitenleiste und Kartensteuerung, mit Form und Schatten der GPS-Marke in neutralen Panel-Farben. Mobil schweben sie oberhalb der sichtbaren Aktionsleiste beziehungsweise „Details“ und verschieben keine Inhalte. Bestehende Meldungen haben Vorrang; währenddessen bleiben Suchhinweis und Fehleraktion bei Bedarf im Ergebnisbereich erreichbar. Anschließend kehrt der laufende Such- oder Optimierungsstatus beziehungsweise Fehler zurück. Neue Suche, Editor, Ansichtswechsel und Navigationsstart entfernen Such-Toasts. Gespeicherte Ergebnisse und Browserhistorie lösen keine nachträglichen Toasts aus. Reduzierte Bewegung und Screenreader-Rückmeldung berücksichtigen.
- Keine sichtbare Stoppaktion anbieten. Navigationsstart, neue Suche und Schließen beenden die Anfragen weiterhin; verspätete Antworten dürfen den Zustand nicht überschreiben. Gespeicherte oder während einer Aktualisierung noch alte Ergebnisse behalten ihre eigenen Hinweise.
- Bereits ausdrücklich ausgewählte oder geöffnete Verbindungen beim Nachladen weiter erhalten.
- Bei Teilfehlern Bereitschaft und Ergebnisse erhalten. Am selben Toast-Platz dauerhaft „Optimierung: Zeitlimit erreicht“, „Optimierung: Anfragelimit erreicht.“ oder bei anderen beziehungsweise gemischten Ursachen „Optimierung nicht vollständig.“ anzeigen. Ein Warndreieck und ein dünner Rahmen in der vorhandenen Warnfarbe kennzeichnen den Hinweis; Hintergrund und Text verwenden weiterhin die neutralen Theme-Farben. Ein Kreispfeil rechts neben dem Fehlertext bietet „Erneut versuchen“ als Tooltip und Screenreader-Beschriftung. Die Schaltfläche hat mindestens 44 × 44 px Bedienfläche und beachtet Offlinezustand und Serverpause; sie setzt die unterbrochene Optimierung fort. Erfolgreiche Routing-Antworten werden innerhalb derselben Berechnung wiederverwendet; offene und fehlgeschlagene Prüfungen erhalten neue Budgets. Auswahl, Details, Leseposition, Standort und ursprünglicher Abfragezeitpunkt bleiben erhalten. Der Toast zeigt direkt „Optimierung läuft …“, ohne Aktualisierungshinweis oder erneute Erfolgsbestätigung. Neue Suche, geänderte Vorgaben, Wiederherstellung und Verlassen der Planung verwerfen den Fortschritt; eine vollständige Aktualisierung bleibt über die bestehende Aktion erreichbar. Interne Phasen und Fehlerdetails bleiben erhalten. Keine erfundenen Fortschrittsprozente oder Fertigstellungszeiten anzeigen.

Die Darstellung orientiert sich an [Doherty Threshold](https://lawsofux.com/doherty-threshold/), [Cognitive Load](https://lawsofux.com/cognitive-load/) und [Hick’s Law](https://lawsofux.com/hicks-law/): frühe nutzbare Rückmeldung, weniger Ablenkung und weniger konkurrierende Aktionen.

Einstieg: [Planungszustand](../web/src/planning-state.ts), [Routensuche](../web/src/planner.ts) und [Ergebnisansicht](../web/src/journey-view.ts).

## 4. Leeren Verlauf an den Einstieg angleichen

**Beobachtung:** Die Startseite bietet Logo und klare Führung. Der leere Streckenverlauf zeigt lediglich einen kleinen Erklärungstext.

**Geplantes Verhalten:**

- Vorhandene Gestaltungsmittel der Startseite für einen erkennbaren Leerzustand verwenden.
- Bei aktiver Speicherung: „Deine nächste Strecke wartet“, kurze Erklärung zur automatischen lokalen Speicherung und Aktion „Route planen“.
- „Route planen“ öffnet die Routensuche und fokussiert das Zielfeld.
- Bei ausgeschalteter Speicherung: Zustand erklären und „Speichereinstellungen öffnen“ anbieten. Die Aktion öffnet die Einstellungen beim Speicherschalter; sie aktiviert nichts automatisch.
- Sobald Strecken vorhanden sind, die vorhandene Verlaufsliste zeigen.

Einstieg: [Verlaufsdarstellung](../web/src/main.ts), [Oberflächenstruktur](../web/index.html) und [Stile](../web/src/style.css).

## 5. Nutzen von Alternativen erklären

**Beobachtung:** Routenkarten zeigen Radzeit, Ankunft und Umstiege bereits an. Unterschiede muss der Nutzer selbst ausrechnen.

**Geplantes Verhalten:**

- Für reguläre Alternativen eine kurze Vergleichszeile zur aktuell empfohlenen Verbindung anzeigen.
- Radzeit und Ankunft vergleichen, etwa „8 min weniger Rad · 6 min später“. Beide Unterschiede aus vorhandenen Reisedaten berechnen und einheitlich auf Minuten darstellen.
- Vergleiche stets auf dieselbe empfohlene Verbindung beziehen. Eine andere Nutzerauswahl verändert diese Referenz nicht.
- Auch frühere Ankunft und längere Radzeit korrekt benennen; gerundete Nullunterschiede weglassen. Wenn beide Unterschiede null sind, Vergleichszeile auslassen.
- Keine Zusatzzeile für die Empfehlung selbst, die Beispielroute, gespeicherte Einzelreisen oder den gesonderten Fahrradvergleich ergänzen.
- Tageswechsel anhand vollständiger Zeitstempel berechnen. Bestehende Angaben zu Umstiegen und Gesamtdauer erhalten.

Einstieg: [Routenkarten](../web/src/journey-view.ts) und [Reisemodelle](../web/src/model.ts).

## 6. Anbieterdaten verständlich aufbereiten

**Beobachtung:** Die Beispielroute enthält Angaben wie „Gleis / Steig Gl2“ und „Gleis / Steig Seinw“. Unverarbeitete Kennungen können wie eindeutig bestätigte Fahrgastinformationen wirken.

**Geplantes Verhalten:**

- Eine gemeinsame Darstellung für Gleis- und Steigangaben in Routendetails und Navigation verwenden.
- Offensichtliche Präfixdoppelungen entfernen, zum Beispiel „Gl2“ bei einer Bahn als „Gleis 2“ darstellen.
- Bei eindeutigem Verkehrsmittel passende Bezeichnung verwenden: Bahn „Gleis“, Bus „Steig“. Ohne eindeutige Zuordnung neutrale Bezeichnung erhalten.
- Bekannte uneindeutige Kennungen wie „Seinw“ neutral als „Anbieterangabe: Seinw“ kennzeichnen. Andere unbekannte Werte nicht durch pauschale Zeichenfilter als ungültig einstufen.
- Keine Gleise, Steige oder Richtungen erraten. Fehlende Werte weiterhin auslassen; Rohdaten und Routing unverändert erhalten.

Einstieg: [Etappendetails](../web/src/journey-detail.ts) und [Navigationsoberfläche](../web/src/navigation-ui.ts).

## Abnahme der späteren Umsetzung

- **Löschschutz:** Bestätigen, Abbrechen, Dialog schließen, leerer Verlauf, vorhandene Wiederaufnahmedaten und Speicherfehler prüfen. Vor Bestätigung darf keine Löschung stattfinden.
- **GPS:** Fehlender, ungenauer und wieder verfügbarer Standort; eingeklappte Details; erreichbare Hilfe und korrekte Fokusführung prüfen.
- **Suche:** Erste Ergebnisse, nachgeladene Alternativen, ausdrückliche Auswahl, Abbruch, verspätete Antwort, Teilfehler und Serverpause prüfen.
- **Verlauf:** Beide Leerzustände, vorhandene Strecken und funktionierende Folgeaktionen prüfen.
- **Vergleiche:** Weniger und mehr Radzeit, frühere und spätere Ankunft, Nullunterschiede, Rundung, Tageswechsel und ausgeschlossene Darstellungsfälle prüfen.
- **Anbieterdaten:** Numerische und alphanumerische Angaben, Präfixe, „Seinw“, unbekannte Werte und fehlende Angaben prüfen.
- Für geänderte Logik gezielte Unit-Tests und für relevante Nutzerabläufe Browsertests ergänzen. Bestehende passende Tests weiterverwenden.
- Mobile Ansichten bei 320 und 390 Pixel Breite sowie Desktop prüfen; Hell/Dunkel, Tastaturbedienung, Fokus und reduzierte Bewegung berücksichtigen.
- Nach späteren Produktänderungen passende Webtests und den Webbuild ausführen. Ein Gerätecheck bleibt für echte Standortwechsel und Navigation erforderlich.

## Worktree

- Name: `premium-ux-plan`
- Branch: `Lars147/premium-ux-plan`
- Basis: Standardbasis des Orca-Repos (`origin/main`), ohne Parent-Worktree.
- Orca-Kommentar: „Premium-UX: sechs priorisierte Verbesserungen geplant.“
- Ergebnis dieser Umsetzung: Änderung 3 mit fortsetzbarer Optimierung und konturierten Kartenbuttons. Die mobile Statuspille im Routenheader bleibt eine lokale Vorschau; Änderungen 1, 4, 5 und 6 bleiben geplant, Änderung 2 ist zurückgestellt.
