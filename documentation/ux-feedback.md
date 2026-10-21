# UX-Feedback: Webplaner

Die Überarbeitung setzt das gesammelte Feedback im Webplaner und der PWA um. Die vorhandene Gestaltung bleibt die Grundlage. Die lokale Vorschau läuft unter http://127.0.0.1:4180/; die feste Beispielroute unter http://127.0.0.1:4180/?example=bike-transfer.

## Änderungen und Abnahme

| Feedback | Ergebnis | Nachweis |
| --- | --- | --- |
| Doppelklick soll nicht zoomen | In Vorschau und Navigation deaktiviert; andere Zoomfunktionen erhalten. | Browserprüfungen für beide Karten. |
| X beendet die Routensuche | Auf Nutzerwunsch zum bisherigen Verhalten zurückgekehrt: X beendet die laufende Suche und verwirft die aktuelle Planung. Der zusätzliche Einstieg zum Wiederöffnen entfällt. | Abbruch vor und nach ersten Ergebnissen; verspätete Antworten werden ignoriert. |
| API-Fehler und lange Laufzeiten | Ortssuche meldet 429 sofort; gesamte Routenberechnung wiederholt einzelne HTTP-Anfragen höchstens zweimal. Einzelpause unter 30 s, insgesamt höchstens 30 s zusätzliche Pause je Lauf; ohne gültigen Header 5 s bei 429. Erfolgreiche Parallelantworten bleiben sofort nutzbar. Arbeitsfristen pausieren mit, laufende HTTP-Zeitlimits nicht. Endgültige 429-Fehler zeigen „Anfragelimit erreicht · N s“ mit Countdown. Manuelle Wiederholung behält Erfolgscache und startet frische Budgets. | Unit-Tests mit echtem API-Client für Pausen, Parallelität, Budgets und Abbruch; Browserprüfungen für sofortigen Ortsfehler, automatischen Routing-Retry, Teilergebnisse, Countdown und X. |
| Routenoptimierung statt Optimierung | Sichtbare Statusmeldungen und Screenreader-Ankündigungen umbenannt. | Quelltextprüfung und Status-Browsertests. |
| Abstände in Verbindungskachel | Kompaktere Fußzeile und mehr rechter Innenabstand bei Details. | Geometrieprüfungen und Screenshots bei 320, 390 und 1280 Pixeln. |
| Fußwegeinstellung erklären | Wirkung für den Weg zur ersten und von der letzten Haltestelle benannt; längere Umstiegswege ausdrücklich erklärt. | Einstellungsansicht und responsive Prüfung. |
| Hinweis für schnellere Routenoptimierung | Weniger Radverbindungen zwischen Linien beschleunigen die Routenoptimierung; Wirkung von 0 erklärt. | Routenoptimierungsgruppe in Einstellungen. |
| Anschlusspuffer umbenennen | Oberfläche verwendet Umstiegszeit. | Quelltextprüfung und Einstellungsansicht. |
| Umstiegszeit einstellbar | 0–30 Minuten, Standard 3. Wird gespeichert und bei API-Anfragen, Rad-Umstiegen sowie Ersatz von Fußwegen verwendet. Alte Daten behalten bisherige Vorgaben. | Migrations-, Validierungs-, URL- und Kompositionstests; Browsertest prüft tatsächlich gesendete API-Werte nach Änderung und Neuladen. |
| Einstellungen ordnen | Rad & Falten, Verkehrsmittel, Wege & Umsteigen, Routenoptimierung, Darstellung & Bedienung, Speicher. | Mobile und Desktopansichten, große Schrift, ungültige Werte und Fokusführung. |
| Radvergleich beschreiben | „Zeigt zusätzlich die reine Radstrecke.“ | Sichtbarer Schaltertext. |
| Speicherung verständlich erklären | Drei unabhängige Schalter für Streckenverlauf, Wiederaufnahme und Fahrtstatistik. Ausschalten erhält Daten; jede Kategorie hat eine eigene bestätigte Löschaktion. | Migration, alle acht Kombinationen, Neuladen, Speicherfehler und getrennte Löschprüfungen. |
| Lizenzen und Datenquellen als Modal | Vollständige Hinweise aus bestehender Lizenzseite eingebettet, ohne zusätzlichen Abruf. Escape und Schließen geben Fokus zurück. | Dialogtests mit großer Schrift, Offlineprüfung im Produktionsbuild und vollständige Original-Lizenzen. |
| Über funktioniert | Eigener Informationsdialog mit Projektbeschreibung, Datenverhalten und GitHub-Link. | Dialogtests, unveränderte App-Adresse, Fokus-Rückgabe. |

## Gestaltungsgrundlage

Die Umsetzung folgt [Laws of UX](https://lawsofux.com/): zusammengehörige Inhalte und Folgen räumlich gruppieren (Law of Proximity, Chunking), Optionen in verständliche Bereiche aufteilen (Hick’s Law), große erreichbare Bedienflächen erhalten (Fitts’s Law) und während langer Vorgänge früh Rückmeldung sowie nutzbare Ergebnisse anbieten (Doherty Threshold).

## Prüfstand

- 475 Unit-Tests erfolgreich.
- Produktionsbuild einschließlich TypeScript und Lizenzprüfung erfolgreich.
- Offlineprüfung der vollständigen Lizenztexte und des Dialogs im Produktionsbuild erfolgreich.
- Gezielte Prüfungen für Navigation, frühes Schließen und Kachelabstände in Chromium und WebKit erfolgreich.
- Breite Regression der betroffenen Ansichten: Chromium 164/164 und WebKit 164/164 erfolgreich.
- Nach dem letzten Text- und Fehlerursachen-Feinschliff 56 gezielte Browserfälle erfolgreich. Zwei bestehende Erwartungen wurden von der allgemeinen Pausenmeldung auf die konkrete Ursache „Zu viele Anfragen“ angepasst und in beiden Browsern erneut bestätigt; während der Pause wird weiterhin keine weitere Anfrage gesendet.
- Abschließende Quelltext-, Formatierungs- und Diff-Prüfung erfolgreich. Finale Einstellungen und Beispielroute lokal in Chrome sichtbar geprüft und geöffnet gelassen.

Prüfkommandos wurden aus `web/` ausgeführt: `npm test`, `npm run build`, die fünf betroffenen Browserdateien (`feedback-ux`, `settings-ux`, `search-progress-ux`, `planner`, `planner-editing-ux`) in beiden Browserprojekten, zusätzliche Navigations- und Produktionsprüfungen sowie die gezielte Nachprüfung nach dem Feinschliff. WebKit lief isoliert mit einem Worker, nachdem der gemeinsame Lauf wiederholt leere Seiten beim Laden zeigte. Produktcode und finale Prüfergebnisse waren davon unabhängig.

Die Laufzeit externer Routingdienste bleibt von deren Auslastung und der Komplexität einer Anfrage abhängig. Die Oberfläche erhält Teilergebnisse, erklärt Wartezustände und vermeidet weitere Anfragen während einer Serverpause. iOS-Code und Deployment wurden nicht geändert.

## Anschlussauftrag: Speicher auftrennen

Die bisherige Einstellung wird beim ersten Lesen auf drei unabhängige Vorgaben übertragen. War sie ausgeschaltet, bleiben alle drei ausgeschaltet. Bereits vorhandene Daten bleiben erhalten.

- **Streckenverlauf speichern:** behält bis zu 20 Planungen. Alte Strecken bleiben auch bei ausgeschaltetem Verlauf nutzbar.
- **Navigation wiederaufnehmen:** speichert den aktuellen Navigationsstand unabhängig vom Verlauf. Ausgeschaltet wird keine Wiederaufnahme angeboten und kein neuer Stand gespeichert.
- **Fahrtstatistik speichern:** zählt abgeschlossene Fahrten unabhängig von Verlauf und Wiederaufnahme.

Unter „Daten verwalten“ lassen sich Verlauf, Navigationsstand und Statistik einzeln löschen. Bestätigungsdialoge erklären jeweils die Folgen; Abbrechen und Escape erhalten alle Daten. Eigene Löschgenerationen verhindern, dass alte Schreibvorgänge gelöschte Daten wiederherstellen. Das Löschen der Statistik unterbindet keine weiteren Navigationsstände.

Die Prüfung umfasst Migration, alle acht Schalterkombinationen, gleichzeitige Änderungen, Neuladen nach dem Ausschalten, Rücknahme fehlgeschlagener Änderungen, getrennte Löschung und verspätete Schreibvorgänge. Mobile Ansichten und Löschdialoge werden auch mit doppelter Schriftgröße geprüft.

Abnahme: 482 Unit-Tests, Produktionsbuild und Formatprüfung erfolgreich. Die 21 neuen Speicherfälle bestehen in Chromium und WebKit. Zusätzlich wurden die betroffenen Einstellungen, der Verlauf, Navigationswiederaufnahme, Fahrtabschluss und die Offline-PWA breit geprüft. Veraltete Erwartungen an die frühere gemeinsame Löschung wurden auf die getrennten Aktionen umgestellt; die gezielten Nachprüfungen bestehen mit 26 Fällen in Chromium und 28 in WebKit. Drei weitere Chromium-Fälle bestätigen den korrekten Löschbutton nach Navigationsende und die Hilfelinks. Eine WebKit-Prüfung für native Chromium-Touchereignisse bleibt plattformbedingt übersprungen.

## Nutzerkorrektur: X beendet die Routensuche

Das Weiterrechnen nach dem Schließen und der zusätzliche Einstieg auf der Startseite wurden auf Nutzerwunsch entfernt. X verwendet wieder den bisherigen Abschluss: laufende Suche abbrechen, aktuelle Planung verwerfen und zur Startseite zurückkehren. Bereits gespeicherte Strecken bleiben im Verlauf erhalten.

Abnahme nach der Rücknahme: 482 Unit-Tests, 18 gezielte Browserfälle in Chromium und WebKit sowie Produktionsbuild und Formatprüfung erfolgreich. Die Browserfälle prüfen insbesondere Abbruch vor ersten Ergebnissen, Abbruch während der Routenoptimierung und das Ignorieren verspäteter Antworten. Die übrigen UX- und Speicheränderungen bleiben erhalten.

## Anschlussauftrag: Update-Block im Entwicklungsmodus

Die Update-Karte bleibt auch in der Entwicklungsansicht sichtbar. Sie zeigt „Entwicklungsmodus – Updates nicht verfügbar“ und deaktiviert die Updateaktionen. Eine Service-Worker-Updateprüfung wird dort weiterhin nicht gestartet. Die Produktionsansicht verwendet weiterhin die reguläre Updatefunktion.

Abnahme: Entwicklungsansicht auf Port 4180 im Browser geprüft, zwölf bestehende Einstellungs- und Layoutfälle in Chromium/WebKit sowie vier Produktionsfälle für die Updatefunktion erfolgreich. Drei zusätzliche Layoutdurchläufe erzeugen die Review-Screenshots. Build, Format- und Diff-Prüfung erfolgreich.

## Anschlussauftrag: HTTP 429 getrennt behandeln

Die Orts-/Haltestellensuche meldet ein Anfragelimit sofort und wiederholt nicht automatisch. Die gesamte Routenberechnung einschließlich erster Route und Geometrie-Recovery wiederholt einzelne HTTP-Anfragen höchstens zweimal. Gültiges `Retry-After` gilt unverändert; ohne gültigen Header beträgt die Pause fünf Sekunden. Automatisch akzeptiert werden einzelne Pausen unter 30 Sekunden und insgesamt höchstens 30 Sekunden zusätzliche Pause je Lauf. Überlappende Pausen zählen einmal. Bereits laufende Parallelantworten bleiben nutzbar und werden einzeln veröffentlicht.

Akzeptierte Pausen verlängern die Arbeitsfristen von Rad-, Fußweg- und Zwischenzielplanung; das Zeitlimit laufender HTTP-Anfragen bleibt bei 20 Sekunden. Jeder tatsächliche Versuch zählt gegen bestehende Anfragebudgets. HTTP 503 bleibt ein eigener Fehler ohne automatische Wiederholung. Erst endgültige Routingfehler zeigen „Anfragelimit erreicht · N s“; die Sekunden zählen visuell bis zur Freigabe der manuellen Wiederholung herunter. X und neue Suche beenden Anfragen und Warteschlangen. Manuelle Wiederholung startet frische Laufbudgets und erhält erfolgreiche Antworten sowie die bestehende Serversperre.

Abnahme vor dem Rebase: 517 Unit-Tests und 208 Browserfälle in Chromium/WebKit erfolgreich geprüft. Nach dem Rebase auf `main` (`2204d88`) bestehen Produktionsbuild, TypeScript-, Lizenz- und Formatprüfung sowie alle 571 Unit-Tests einschließlich der inzwischen hinzugekommenen Tests aus `main`. Zusätzlich bestehen 52 Browserfälle in Chromium/WebKit für Routing-Retries, geteilte Adressen mit Standortaktualisierung sowie PWA-Updates einschließlich Produktions- und Offlineprüfung.
