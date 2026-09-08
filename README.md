# FoldRoute

FoldRoute ist ein nativer iOS-Prototyp für durchgehende Navigation mit Klapprad und öffentlichem Verkehr. Er plant eine empfohlene Reise aus Rad-, Falt-, ÖPNV-, Entfalt- und Fußabschnitten und begleitet sie mit Karte, Sprache, Haptik und Zeitwarnungen.

## Projektstruktur

- `ios/`: native iPhone-App, Xcode-Projekt und Swift-Tests.
- `web/`: Webplaner, Build-Konfiguration und Webtests.
- `docs/`: Website mit dem gebauten Webplaner unter `plan/`.

Alle folgenden Projektpfade beziehen sich auf das Repository-Hauptverzeichnis.

## Schnellstart

Voraussetzungen: Xcode 26 oder neuer, iOS 18 oder neuer, Apple-Entwicklerteam für ein physisches Gerät.

1. `ios/FoldRoute.xcodeproj` in Xcode öffnen.
2. Im Target **FoldRoute** unter **Signing & Capabilities** eigenes Team und bei Bedarf eigene Bundle-ID wählen.
3. iPhone oder kompatiblen Simulator auswählen und **Run** starten.
4. Unter **Wohin?** ein Ziel suchen oder eines der letzten Ziele antippen. Standort erlauben; die Route wird sofort ab aktuellem Standort für jetzt berechnet. In der Vorschau **Navigation starten** wählen.

Die Startseite zeigt die Zielsuche und bis zu fünf zuletzt verwendete Orte. Start- und Zielsuche nutzen dieselbe Liste, sortiert nach der letzten Verwendung. Beide zeigen **Aktueller Standort** dauerhaft bei leerer Suche. Antippen ermittelt den Standort; fehlende Freigabe oder GPS-Daten werden als Meldung angezeigt. Startpunkt sowie Abfahrts- oder Ankunftszeit lassen sich in der Vorschau über **Route anpassen** ändern. Ohne verfügbaren Standort bietet die App **Start wählen** und **Erneut versuchen** an. Änderungen im Anpassungsdialog werden erst nach erfolgreicher Berechnung übernommen; **Abbrechen** erhält die vorherige Route.

Orte lassen sich über den **Stern** in Suchergebnissen und Ortslisten als Favoriten markieren oder wieder entfernen. Markieren startet keine Route. Startseite, Start- und Zielauswahl zeigen dieselben Favoriten alphabetisch oberhalb von **Zuletzt verwendet**. Favoriten behalten Originalnamen und Adresse und erscheinen nicht doppelt in der Liste der letzten Orte. Sie bleiben nach Neustarts und beim Aufräumen älterer Orte erhalten; **Alle lokalen Daten löschen** entfernt sie ebenfalls. Favorisieren allein zählt nicht als Nutzung. **Aktueller Standort** lässt sich nicht favorisieren.

Die Ortssuche bietet beim Tippen ab zwei Zeichen Apple-Autovervollständigung mit bis zu zwölf Adress- und Ortsvorschlägen. Vorhandene aktuelle Standortdaten dienen als regionaler Bezug, andernfalls eine voreingestellte Suchregion; ausdrücklich genannte andere Städte bleiben suchbar. Passende Favoriten erscheinen zusätzlich. Erst die Auswahl oder das Favorisieren eines unbekannten Vorschlags löst dessen genaue Koordinaten auf. Mehrdeutige Ergebnisse benötigen eine weitere Auswahl.

Der **↖-Pfeil** übernimmt den Namen plus Leerzeichen ins Suchfeld und setzt den Cursor ans Ende, etwa für eine Hausnummer. Er startet weder Suche noch Routenplanung. Erst weiteres Tippen oder die Tastaturaktion **Suchen** lädt neue Vorschläge; die Tastatur bleibt zum Bearbeiten offen. Pfeil, Stern und Ortsname sind getrennte Aktionen. Fehler lassen die Suche offen; neue Eingabe oder Schließen verwirft verspätete Antworten. Anzahl und Inhalt der Vorschläge hängen von Apple ab.

Die Routenübersicht hat drei Größen: Kopfzeile, normale Übersicht und große Ansicht. Ziehe den Griff nach oben oder unten; Antippen klappt ein oder stellt die zuletzt offene Größe wieder her. Ein Tipp auf die freie Karte minimiert die Übersicht. Ein Routentipp wechselt die ausgewählte Route und behält die aktuelle Größe der Übersicht bei. In der minimierten Kopfzeile startet der gelbe **Los**-Button die Navigation; die offene Übersicht bietet weiterhin das X zum Schließen. Bei großer Schrift oder wenig Bildschirmhöhe scrollt die Kopfzeile mit den Etappen; die Aktionen bleiben erreichbar.

Nach vollständigem Schließen wird eine nur geplante Route verworfen. Bereits gestartete Navigation wird mit dem gespeicherten Abschnitt und Manöver automatisch fortgesetzt. Beenden oder Ankunft löscht den Wiederherstellungszustand; letzte Orte, Verlauf und Einstellungen bleiben erhalten. Hintergrundwechsel verändert die laufende Sitzung nicht. Alte Routenspeicher ohne Navigationsstatus gelten als Planung.

Die aktive Navigation öffnet sofort eine um 45° geneigte Detailkarte in Fahrtrichtung. Sie folgt dem Standort und berücksichtigt die Höhe der Infokarten. Die Kameraentfernung beträgt 600 Meter beim Radfahren, 350 Meter zu Fuß und 1.500 Meter im ÖPNV; beim Falten und Warten bleibt der letzte Maßstab erhalten. Im Stand bleibt die Blickrichtung stabil. Verschieben, Drehen oder Zoomen pausiert das Mitführen; der Standortknopf **Navigation zentrieren** aktiviert es wieder. Ohne brauchbares GPS bleibt die letzte gültige Position sichtbar, beim Wiederherstellen zunächst der gespeicherte aktuelle Abschnitt. Die Routenplanung behält ihre Gesamtübersicht.

Nach bestätigtem **Navigation beenden** berechnet FoldRoute bis zu drei aktuelle Routen ab dem aktuellen Standort zum bisherigen Ziel, mit Abfahrt jetzt. Die Karte bleibt während der Berechnung sichtbar. Bei Standort- oder Netzwerkproblemen bietet das Panel einen erneuten Versuch und die Anpassung des Starts an; die beendete Navigation bleibt gestoppt. Schließen oder eine neue Zielauswahl verwirft noch ausstehende Ergebnisse. **Fahrt abschließen** nach Ankunft löst keine Neuberechnung aus.

Im Anpassungsdialog steht **Start** oben und **Ziel** darunter. Beide Felder öffnen per Antippen die Ortssuche. Mit dem **Tauschsymbol (↕)** dazwischen lässt sich die Fahrtrichtung umkehren. Die gewählte Zeit bleibt erhalten; **Route berechnen** übernimmt die Änderungen nach erfolgreicher Planung.

Kein API-Schlüssel und kein Backend nötig. Die App ist deutsch, metrisch und auf iPhone-Portrait optimiert.

### Fuß- und Rad-Zubringer

FoldRoute vergleicht Fuß–ÖPNV–Fuß, Fuß–ÖPNV–Rad, Rad–ÖPNV–Fuß und Rad–ÖPNV–Rad sowie eine direkte Radfahrt. Unter **Einstellungen → Fußwege** lässt sich die maximale Gehzeit je Zubringer auf 1–15 Minuten einstellen, standardmäßig **2 Minuten**. Sie gilt separat vor dem ersten Einstieg und nach dem letzten Ausstieg; Faltzeiten, Wartezeiten und Fußwege beim Umsteigen zählen nicht dazu. Das Klapprad bleibt dabei und wird auf Fuß-Zubringern geschoben; Falten und Entfalten werden weiterhin eingeplant.

Die Basisberechnung verwendet höchstens fünf Anfragen und maximal zwei gleichzeitig. Ergebnisse erscheinen schrittweise. Bei Abfahrt entscheidet die früheste Gesamtankunft, bei Ankunftsvorgabe die späteste Abfahrt. Gleichstände werden nach weniger ÖPNV-Umstiegen, weniger Radetappen, kürzerer Radstrecke und kürzerem Fußweg aufgelöst. Varianten derselben konkreten ÖPNV-Fahrt werden zusammengefasst. Eine ausdrücklich ausgewählte Route bleibt bei späteren Ergebnissen erhalten. Bei Teilfehlern bleiben gefundene Verbindungen nutzbar; eine Ratenbegrenzung stoppt weitere Anfragen.

### Einstellungsänderungen bei geplanter Route

Änderungen an Radtempo, Gehzeit, Faltzeiten, Verkehrsmitteln oder Rad-Umstiegen verwerfen die bisherige Routenauswahl sofort. Beim Verlassen der Einstellungen plant FoldRoute automatisch mit den letzten Werten neu. Mehrere Änderungen werden zusammengefasst; der Speicherknopf allein startet keine Suche. Start, Ziel und Zeitwahl bleiben erhalten. „Aktueller Standort“ wird aktualisiert, „Jetzt“ neu ausgewertet; abgelaufene feste Zeiten erfordern eine Anpassung. Bei Fehlern bleibt die alte Route entfernt, und „Erneut versuchen“ erhält den Planungskontext.

Sprachansagen und Haptik lösen keine neue Route aus. Ohne bisherige Planung werden nur die Einstellungen gespeichert. Eine bereits gestartete Navigation bleibt bestehen. Alte Erst- und Nachsuchergebnisse können keine verworfene Route wiederherstellen.

### Nutzen der ÖPNV-Alternativen

ÖPNV-Verbindungen werden vor der Kartenauswahl mit der zeitlich besten direkten Radroute verglichen. Sie müssen mindestens **3 Minuten sparen** oder **mindestens 20 % und mindestens 1 km Radstrecke sparen**, bei höchstens **10 Minuten zusätzlicher Reisezeit**. Bei Ankunftsvorgabe zählt entsprechend die spätere mögliche Abfahrt bzw. höchstens zehn Minuten frühere Abfahrt. Falten, Entfalten und Wartezeiten sind in den Gesamtzeiten enthalten. Bewertet wird die gesamte Reise; kurze Einzelabschnitte sind nicht pauschal ausgeschlossen.

Ungeeignete Verbindungen werden nicht als zusätzliche Karten aufgefüllt. ÖPNV-Ergebnisse erscheinen erst, wenn die parallel gestartete Radabfrage abgeschlossen ist; fehlt eine Radreferenz, bleibt die bisherige ÖPNV-Auswahl verfügbar. Die Bewertung benötigt keine zusätzlichen Anfragen. Rohkandidaten bleiben für die Suche nach besseren Rad-Umstiegen erhalten, deren fertige Gesamtrouten denselben Filter durchlaufen. Schwellenwerte sind vorerst fest und ändern keine Einstellungen oder bereits laufende Navigation.

### Fahrrad zwischen ÖPNV-Fahrten

Unter **Einstellungen → Rad-Umstiege** sind 0–3 interne Radetappen einstellbar, standardmäßig zwei. Die Fahrzeit je Radstrecke beträgt höchstens 1–60 Minuten, standardmäßig 15 Minuten. Null deaktiviert die zusätzliche Suche. Erste und letzte Radetappe zählen nicht mit. Falten, Entfalten und drei Minuten Anschlusspuffer kommen zur Fahrzeit hinzu; vorhandene Tempo- und Verkehrsmittel-Einstellungen gelten weiterhin.

Zunächst erscheinen die normalen Alternativen. Anschließend prüft FoldRoute zusätzliche Kombinationen aus ÖPNV, Rad und erneutem ÖPNV und ergänzt die besten Ergebnisse. Eine ausdrücklich ausgewählte Route bleibt erhalten. Schließen, neue Planung oder Navigationsstart beendet die Nachsuche. Bei Fehlern bleiben bereits gefundene Optionen nutzbar.

Die Suche funktioniert vorwärts bei Abfahrt und rückwärts bei Ankunft. Sie verwendet Ein- und Ausstiegspunkte bereits gefundener Verbindungen: höchstens drei Kandidaten je Stufe, vier zusätzliche Anfragen je Stufe, zwei gleichzeitig und insgesamt 15 Sekunden Nachsuche. Sie durchsucht nicht alle Haltestellen oder denkbaren Kombinationen und garantiert daher kein globales Optimum. Ein Rad-Umstieg erscheint nur, wenn eine passende Kombination gefunden wird und sie in die ausgewählten Alternativen fällt.

Zusammengesetzte Routen behalten Fahrtkennungen für Echtzeitaktualisierung und Wiederherstellung. Anschlussprüfungen berücksichtigen interne Radetappen, Faltzeiten und den verbleibenden Puffer.

### Echtzeit während der Navigation

Bei aktiver Navigation werden aktuelle und verbleibende ÖPNV-Fahrten beim Start und anschließend etwa alle 60 Sekunden über Transitous `/api/v6/trip` aktualisiert. Fahrtkennung, Haltestellenkennungen und ursprüngliche Ereigniszeiten identifizieren die gewählten Ein- und Ausstiege. Zeiten und Gleise aktualisieren sich ohne Zurücksetzen des Navigationsfortschritts. Die Anzeige unterscheidet Echtzeit, Fahrplan, fehlgeschlagenen Abruf und nicht verfügbare Aktualisierung samt letztem erfolgreichen Abrufzeitpunkt.

Ausfälle und gefährdete Anschlüsse lösen einen Hinweis und einen Vorschlag für eine neue Verbindung aus. Der Wechsel benötigt eine Bestätigung. Im Zug beginnt die Alternative am vorgesehenen Ausstieg und erhält den aktuellen Abschnitt; bei einem als ausgefallen gemeldeten aktuellen Halt muss der tatsächliche Ausstieg zunächst vor Ort geprüft und bestätigt werden. Bei anderen Abschnitten wird ab aktuellem Standort geplant. Abgelehnte Vorschläge ändern die aktive Verbindung nicht.

Fehler behalten die letzte Route bei. Wiederholungen erfolgen nach 2, 4 und anschließend 5 Minuten; längere `Retry-After`-Vorgaben werden eingehalten. Veraltete oder ausgefallene ÖPNV-Daten beenden keinen Navigationsabschnitt allein anhand der Uhrzeit. Lokale Erinnerungen werden bei Änderungen ersetzt, abgeschlossene und unzuverlässige Abschnitte werden ausgelassen. Ältere gespeicherte Fahrten ohne Kennungen bleiben nutzbar und bieten eine Neuberechnung an.

Hintergrundaktualisierung nutzt die vorhandene Standortnavigation; iOS garantiert keine exakten Intervalle. Bei Rückkehr in den Vordergrund werden fällige Abfragen nachgeholt. Während vollständiger App-Beendigung finden keine Abfragen statt. Datenabdeckung und Aktualität hängen von den Verkehrsunternehmen und Transitous ab.

## Enthalten

- Direkte Ortssuche über MapKit mit regionalem Suchbezug und sofortiger Routenberechnung nach Zielauswahl
- Parallele Transitous/MOTIS-v6-Abfrage für ÖPNV plus Klapprad und direkte Radroute
- Eine priorisierte Route mit Echtzeitkennzeichnung, Linien, Richtung und Gleisen
- Konfigurierbare Falt- und Entfaltzeiten, standardmäßig 3 und 2 Minuten
- Explizite Phasen für Rad, Falten, Fußweg, ÖPNV und Entfalten
- Sicherer Navigationsstart: Standortprüfung, Rad-Anfahrt zum geplanten Start und automatische Anschluss-Neuplanung
- GPS-Fortschritt, Abbiegehinweise, Sprachansagen, Haptik und Neuplanung nach wiederholter Abweichung
- Hintergrundortung während aktiver Navigation und lokale ÖPNV-Erinnerungen
- Lokale Einstellungen, letzte Ziele, aktive Route und maximal 20 Fahrtzusammenfassungen via SwiftData
- Keine Konten, Cloud-Synchronisation oder gespeicherte GPS-Spuren

## Architektur

`AppModel` koordiniert den Ablauf. `TransitousClient` implementiert die austauschbare `JourneyPlanning`-Grenze und übersetzt MOTIS-Daten in eigene Domain-Modelle. `NavigationEngine` arbeitet nur auf diesen Modellen. `LocationService` liefert flüchtige GPS-Daten, `GuidanceService` Sprache/Haptik/Benachrichtigungen und `SwiftDataJourneyStore` lokale Persistenz.

Apple-Frameworks: SwiftUI, MapKit, Core Location, SwiftData, AVFoundation und UserNotifications. Keine Drittanbieterpakete.

## Tests

Unit-Tests prüfen Polyline-Decoding, MOTIS-Queries, Zeitverschiebungen für Falten/Entfalten, direkten Rad-Fallback, HTTP-Fehler, SwiftData-Roundtrips sowie Standortgrenzen und Anfahrts-Komposition. Zusätzlich prüfen sie zielbezogenen Verlauf, sofortige Planung mit aktuellem Standort, parallele Anfragen, unveränderte Routen nach fehlgeschlagenen Anpassungen und verspätete oder abgebrochene Suchantworten.

```sh
xcodebuild \
  -project ios/FoldRoute.xcodeproj \
  -scheme FoldRoute \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  test
```

Falls Xcode meldet, dass eine iOS-Plattform fehlt: passendes Simulator-Runtime unter **Xcode → Settings → Components** installieren. Verifiziert ist das Projekt mit Xcode 26.6 und iOS-26.5-Simulator.

Beim Start nutzt FoldRoute nur Standorte, die höchstens 60 Sekunden alt und auf höchstens 100 Meter genau sind. Unter 250 Meter Entfernung startet die geplante Route direkt. Bis 25 Kilometer wird eine gestrichelt dargestellte Rad-Anfahrt zum ursprünglichen Start vorgeschaltet. Ist ein Anschluss dadurch nicht mehr erreichbar, plant FoldRoute automatisch die nächste Verbindung. Bei größerer Entfernung bleibt Navigation gesperrt und bietet **Route ab hier planen** an.

## Manuelle Abnahme

Diese fünf Fahrtentypen mit passenden Orten in der Testregion auf einem echten iPhone testen. Ziel: Route wird berechnet, alle Phasen stimmen zeitlich, Linien/Gleise sind plausibel, GPS-Fortschritt funktioniert und die Fahrt kann abgeschlossen werden.

1. Innenstadt → Stadtteilzentrum
2. Bahnhof → nahe gelegenes Ziel mit kurzem Fußweg
3. Wohnadresse → Ziel mit Rad-Anfahrt und ÖPNV
4. Innenstadt → Stadtrand mit Umstieg
5. Bahnhof → Ausflugsziel mit Radstrecke nach dem ÖPNV

Zusätzlich je eine Fahrt mit **Abfahrt**, **Ankunft**, direkter Radroute und absichtlicher Abweichung prüfen. Nicht während der Fahrt am Telefon bedienen.

## Daten, Regeln und Grenzen

Beim Planen gehen Start, Ziel und Zeitpunkt direkt an [Transitous](https://transitous.org/api/). MapKit verarbeitet Ortssuchen. Für erneut planbare Fahrten speichert FoldRoute Start und Ziel lokal, aber keine GPS-Spur. Attributionen sind in den Einstellungen sichtbar; Kartendaten stammen unter anderem von [OpenStreetMap-Mitwirkenden](https://www.openstreetmap.org/copyright).

Letzte Ziele werden bereits bei der Auswahl gespeichert, auch wenn keine Route berechnet oder gefahren wird. Reine Startorte verändern die Reihenfolge dieser Liste nicht. Ältere App-Versionen unterscheiden Startorte und Ziele noch nicht: Diese Einträge bleiben gespeichert und in der Startsuche verfügbar, erscheinen auf der neuen Startseite aber erst nach erneuter Auswahl als Ziel.

Transitous ist ein Best-Effort-Dienst. Dieser Stand eignet sich für einen leichten, nicht kommerziellen Prototyp. Vor breiter oder kommerzieller Veröffentlichung sind eigener Routingbetrieb oder schriftlich geklärte Nutzung, Monitoring, Missbrauchsschutz und Server-seitige Konfiguration nötig.

Nicht enthalten: Ticketkauf, Apple Watch, CarPlay, Indoor-Navigation, Offline-Karten, Fahrrad-Hardware und Konten.

## Anpassung

- Kontaktkennung für Transitous: `TransitousContact` in `ios/FoldRoute/Info.plist`
- Bundle-ID und Version: Build Settings im App-Target
- Faltzeiten: in der App unter **Einstellungen → Klapprad**

Änderungen vor Merge mit einem Geräte-/Simulator-Build und Tests prüfen. Fehlerfälle möglichst früh und explizit behandeln; externe DTOs nicht direkt in UI oder Navigation verwenden.

## Lizenz

MIT, siehe [LICENSE](LICENSE).

## Landingpage

Der deutsche Landingpage-Entwurf liegt in [`docs/index.html`](docs/index.html). Er nutzt das vorhandene Logo und die Projektfarben, funktioniert ohne Build-Schritt und lädt keine externen Schriften oder Analyse-Tools. Die Karte und die klickbaren Reiseabschnitte sind Illustrationen, keine echte Routenplanung.

Für eine lokale Vorschau `docs/index.html` im Browser öffnen. HTML, CSS, JavaScript und Logo liegen vollständig im Ordner `docs`.

Für GitHub Pages nach dem Push im Repository **Settings → Pages → Build and deployment → Deploy from a branch** wählen. Den Branch mit der Landingpage und den Ordner **`/docs`** auswählen und speichern. Siehe [GitHub-Anleitung](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

Das gemeinsame Repository ist `Lars147/foldroute`. Es bleibt vorerst privat; eine Veröffentlichung und GitHub Pages werden separat eingerichtet.


## Später Routenstart und Rad-Zubringer

Beginnt die ausgewählte Route mindestens 60 Minuten nach dem gewünschten Start, zeigt die Vorschau nach Ende der Suche einen Hinweis mit Zugang zu den Einstellungen. Bei „Jetzt“ wird der Anfragezeitpunkt einmal festgehalten; bei einer Ankunftssuche entfällt der Hinweis. In der minimierten Vorschau öffnet der kurze Hinweis die normale Übersicht. Auch unvollständige Suchergebnisse können den Hinweis zeigen; bessere Verbindungen werden nicht zugesichert.

„Maximale Radzeit je Zubringer“ begrenzt erste und letzte Radetappe jeweils auf 5–60 Minuten (5-Minuten-Schritte, Standard 30). Falten und Entfalten kommen hinzu. „Fahrzeit je Radstrecke“ unter Rad-Umstiege begrenzt weiterhin ausschließlich Radstrecken zwischen zwei ÖPNV-Fahrten. Änderungen lösen beim Verlassen der Einstellungen die vorhandene Neuberechnung aus. Bestehende Installationen behalten die bisherige 30-Minuten-Grenze für Zubringer.


## Routen manuell aktualisieren

„Aktualisieren“ neben „Route anpassen“ berechnet alle Alternativen neu. Start, Ziel und Einstellungen bleiben erhalten; „Aktueller Standort“ wird neu lokalisiert und „Jetzt“ erhält einen neuen Anfragezeitpunkt. Feste zukünftige Zeiten bleiben bestehen, abgelaufene Zeiten müssen über „Route anpassen“ korrigiert werden.

Die Karte zeigt währenddessen den Ladezustand. Nach Abschluss wird die schnellste Alternative ausgewählt; die normale beziehungsweise maximierte Panelgröße bleibt erhalten. Bei Fehlern behält „Erneut versuchen“ den Planungskontext. Schließen bricht laufende Abfragen ab. In der minimierten Ansicht zuerst die Übersicht aufklappen. Bei großer Bedienungshilfe-Schrift stehen Aktualisierung und Anpassung untereinander.

### Prüfung der Streckengeometrie

Rad- und Fußabschnitte werden vor Veröffentlichung geprüft: geografisch gültige Punkte, passende Endpunkte und zusammenhängende Abbiegeschritte (100 Meter Toleranz). Fehlende Linien werden aus gültigen Schrittgeometrien zusammengesetzt; nur Fußverbindungen bis 100 Meter dürfen ohne diese Daten auskommen. Lange gerade Kanten allein gelten nicht als Fehler. ÖPNV-Geometrien werden nicht nach diesen Straßenregeln bewertet.

Bei fehlerhaften Daten erfolgt höchstens eine zusätzliche Anfrage ohne lokalen Antwortcache. Direkte Radrouten mit Ankunftsvorgabe werden dabei anhand ihrer berechneten Abfahrt vorwärts neu gesucht. Ein Ersatz muss die Ankunftsvorgabe einhalten; seine Zeiten werden nicht nachträglich verschoben. Gültige Alternativen bleiben erhalten, weiterhin fehlerhafte Ergebnisse werden verworfen. Ohne gültiges Ergebnis erscheint eine Fehlermeldung. Navigation und Wiederaufnahme prüfen die verwendeten Straßenabschnitte ebenfalls.

Aufzugsschritte mit 0 Metern dürfen ohne eigene Liniengeometrie geliefert werden. Ihre angrenzenden Wegpunkte müssen innerhalb von 25 Metern liegen; dann erhält der Schritt einen Ankerpunkt, während „Aufzug nehmen“ erhalten bleibt. Zusammenhängende Gruppen solcher Schritte werden gemeinsam geprüft. Die Ausnahme gilt nicht für leere gewöhnliche Weg- oder Treppenschritte und löst keine Reparaturanfrage aus. Normalisierte Ankerpunkte werden mit der Route gespeichert und bei Wiederaufnahme weiterverwendet.

Bestätigte Haltestellen-Endpunkte mit einer nicht leeren Routingdienst-ID erlauben bis zu 500 Meter Abstand zwischen Haltestellenpunkt und Linien-/Schrittende. Adressen und aktuelle Standorte ohne Haltestellenkennung verwenden weiterhin 100 Meter. Das kennzeichnet nur eine plausible Zuordnung; es ergänzt weder eine Wegstrecke noch Reisezeit und ändert keine automatische Ankunftserkennung. Die optionale Haltestellen-ID wird im Ort gespeichert und bleibt bei Routenänderungen und Wiederaufnahme erhalten. Alte Orte ohne ID bleiben lesbar. Weglücken bleiben auf 100 Meter, Aufzugsanschlüsse auf 25 Meter begrenzt. Die lokale Log-Kategorie `StreetGeometry` protokolliert größere Endpunktabweichungen und Ablehnungen mit Abstand und Grenze, ohne Namen, IDs oder Koordinaten.

### Hinweise bei unterbrochener Routensuche

Die Übersicht nennt konkrete Ursachen: fehlendes Netz, Zeitüberschreitung einer Anfrage, Serverfehler, zu viele Anfragen, unlesbare Antworten, abgelehnte Streckengeometrie oder das Zeitbudget der zusätzlichen Verbindungssuche. Mehrere Ursachen werden ohne Wiederholungen angezeigt. Bereits gefundene Routen bleiben verfügbar; nach einer fehlgeschlagenen manuellen Aktualisierung werden die bisherigen Ergebnisse wiederhergestellt. Speicherfehler und unerwartete lokale Fehler erhalten eigene Hinweise. Erfolgreich reparierte Geometrie erzeugt keinen Fehlerhinweis.

Liefert der Routingdienst bei HTTP 429 oder 503 ein zukünftiges `Retry-After` (Sekunden oder HTTP-Datum), gilt diese Pause für alle neuen `/plan`-Anfragen im laufenden App-Prozess, einschließlich Geometrie-Reparaturen und zusätzlicher Umstiegssuchen. Ein Countdown erklärt gesperrte Schaltflächen. Nach Ablauf kann man wieder selbst anfragen; die App startet dadurch keine automatische Neuberechnung. Ohne gültige Wartezeit wird kein Countdown erfunden. `/trip`-Aktualisierungen während der Navigation behalten ihre separate Wiederholungslogik. Es gibt keinen zusätzlichen allgemeinen Anfragenbegrenzer und keinen neuen Cache.

### Webplaner

Die Landingpage verlinkt unter `docs/plan/` einen eigenständigen Webplaner für Faltrad und ÖPNV. Er berechnet Routen direkt im Browser über Transitous und übernimmt Zielsuche und Routenpanel aus dem iOS-Ablauf. Als installierbare PWA kann er die zuletzt gewählte Reise offline anzeigen; die iPhone-App übernimmt weiterhin die Navigation. Quellen, Build- und Testbefehle sowie Hinweise zur Veröffentlichung stehen in [web/README.md](web/README.md).

### Gemeinsame Faltzeit

Unter „Klapprad“ stellt „Falten / Entfalten“ dieselbe Dauer für jeden der beiden Vorgänge ein: 1–10 Minuten in 30-Sekunden-Schritten, mit genauer Anzeige der halben Minuten. Neuinstallationen beginnen mit 3 Minuten je Vorgang. Bei alten Einstellungen wird der größere der beiden Werte übernommen; die vorhandenen Datenbankfelder bleiben kompatibel und erhalten beim Speichern denselben Wert. Bereits berechnete Fahrten und gespeicherte Navigationsabschnitte werden dadurch nicht nachträglich verschoben.

### Abfahrt und Ankunft in der Übersicht

Jeder Routenvorschlag zeigt Abfahrt am Startort und Ankunft am Ziel gleichwertig in der Kopfzeile, darunter die Gesamtdauer. Bei ausreichend Platz stehen die Zeiten nebeneinander, sonst untereinander. Uhrzeiten an anderen Kalendertagen erhalten einen Datumszusatz. In der kleinen Ansicht bleibt „Los“ rechts; bei großer Schrift oder zu geringer Breite wandert der Button unter die Zeitangaben. Lange Kopfzeilen sind scrollbar.
