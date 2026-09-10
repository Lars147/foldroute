# FoldRoute Webplaner

[Projektübersicht](../README.md) · [Routingdetails und Plattformgrenzen](../documentation/routing.md)

Browserbasierte Routenplanung für Faltrad und ÖPNV. Vite/TypeScript, Leaflet und direkte Transitous-Anfragen; kein eigener Server, keine Konten, keine Analyse-Tools. Gültige Routing-Einstellungen werden in `localStorage` gespeichert. Optional bleiben die letzten 20 unterschiedlichen Strecken einschließlich Start, Ziel, Zwischenzielen, Etappen, Geometrie, Einstellungen und Abfragezeit in IndexedDB. Favoriten und bis zu 20 zuletzt ausgewählte Orte bleiben ebenfalls lokal; keine eingegebenen Suchtexte und keine GPS-Spuren.

## Entwickeln und bauen

Voraussetzung: Node.js 22.12+ und npm.

```sh
cd web
npm ci
npm run dev
npm test
npm run build
```

Der Build ersetzt ausschließlich `docs/plan/`. Landingpage und deren Assets bleiben erhalten. GitHub Pages kann weiterhin das Verzeichnis `docs/` ausliefern; der Planer liegt unter `plan/`. Relative Bundle-URLs funktionieren auch unter einem Repository-Unterpfad. Zum lokalen Testen die Seite über HTTP öffnen, nicht über `file://`. `npm run preview` liefert den fertigen Build aus.

## Gesamte Website lokal ansehen

Die Landingpage liegt in `docs/index.html` und benötigt selbst keinen Build. Logo, HTML, CSS und JavaScript liegen lokal; die Karten und klickbaren Reiseabschnitte sind Illustrationen. Für echte Planung führt der Link zu `plan/`.

Aus dem Repository-Hauptverzeichnis den Webplaner bauen und anschließend die Website ausliefern:

```sh
cd web
npm ci
npm run build
cd ..
python3 -m http.server 4174 --bind 127.0.0.1 --directory docs
```

- Landingpage: [http://127.0.0.1:4174/](http://127.0.0.1:4174/)
- Gebauter Webplaner: [http://127.0.0.1:4174/plan/](http://127.0.0.1:4174/plan/)

Bei reinem Landingpage-Text- oder CSS-Ändern genügt Neuladen. Änderungen am Webquellcode erfordern für diese Vorschau einen neuen Build. Der Entwicklungsserver auf Port 4173 liefert dagegen direkt den Planer unter `/` mit automatischer Aktualisierung.

## Tests

Die folgenden Befehle werden in `web/` ausgeführt. Die Browsertests benötigen standardmäßig die Ports 4173 und 4174 exklusiv. Mit `FOLDROUTE_TEST_PORT=4283 npm run test:browser` nutzen sie stattdessen 4283 und 4284, ohne laufende Vorschauen zu beenden. Ihr Testserver liefert das Repository-Hauptverzeichnis aus, weshalb der interne Testpfad `/docs/plan/` von der obigen Website-Vorschau abweicht.

```sh
npm run test:parity
npx playwright install chromium webkit
npm run build
npm run test:browser
```

Die Browsertests benötigen zusätzlich Python 3 für den statischen Testserver. Service-Worker-Tests laufen auf dem fertigen Build unter einem Unterpfad. Der Paritätstest benötigt macOS und Swift. Er kompiliert die unveränderten nativen Routingdateien aus `../ios/` und führt sie mit `URLProtocol`-Testantworten aus, ohne Netzwerkzugriff. `tests/fixtures/swift-parity.json` enthält dieselben normalisierten Transitous-Antworten und native Referenzergebnisse. Vitest vergleicht daraus Abfahrten, Ankünfte, Etappen, Faltzeiten und Auswahl. Nach bewussten nativen Änderungen: `sh scripts/parity.sh --update`; anschließend die Referenzänderungen prüfen. Der Harness ersetzt ausschließlich den für Routing irrelevanten Typ `NavigationProgress`.

Zusätzliche Tests prüfen Anfrageparameter, Ausschlüsse, Geometrie, Zeitvorteil, Vorwärts-/Rückwärts-Verknüpfung, Teilergebnisse, Abbruch und Rate-Limits. Browsertests verwenden abgefangene API-Anfragen und keine echten Routingdienste. Screenshots entstehen für 320, 390, 768 und 1479 Pixel Breite. Das sind gezielte Paritätsfälle, kein Beweis identischer Ergebnisse für alle denkbaren Netze und Datenfehler. Der Vergleich prüft gemeinsame Standardwerte von jeweils 180 Sekunden und zusätzlich Abfahrts-/Ankunftsfälle mit 60, 150 und 360 Sekunden je Vorgang. Weitere Tests prüfen Favoriten, Migrationen, Auswahl während der Nachsuche und Einstellungen. Die browserseitige Distanzprüfung verwendet Haversine, die App CoreLocation; Grenzfälle direkt an Abstandstoleranzen können abweichen.

## Routing und Grenzen

- Direkte Radroute sowie vier Kombinationen aus Rad-/Fuß-Zubringer und -Abbringer.
- Konfigurierbare Geschwindigkeit, Zugangszeiten, Falt-/Entfaltzeiten, Verkehrsmittel und zusätzliche Radverbindungen zwischen Linien.
- Progressive Ergebnisse; bis zu drei reguläre Alternativen plus optionaler Fahrradvergleich. Eine ausdrücklich ausgewählte Reise bleibt beim Nachladen ausgewählt; automatische Auswahl folgt besseren Ergebnissen.
- Maximal zwei gleichzeitige Routinganfragen. Zusätzliche Rad-Umstiege: höchstens vier Anfragen je Tiefe, maximal drei Tiefen und insgesamt 15 Sekunden Suchbudget. Geometriefehler werden einmal erneut abgefragt; HTTP-Fehler werden nicht automatisch wiederholt.
- „Falten / Entfalten“ verwendet wie iOS eine gemeinsame Dauer: Standard 180 Sekunden je Vorgang, einstellbar von 60 bis 600 Sekunden in 30-Sekunden-Schritten. Bisherige getrennte Einstellungen werden beim Laden auf den größeren Wert zusammengeführt.
- HTTP 429 und lesbare `Retry-After`-Angaben bei 429/503 stoppen weitere Planung. Eine laufende zweite Anfrage kann beim Eintreffen bereits unterwegs sein. Ohne CORS-Freigabe des Headers kennt der Browser keine exakte Wartefrist.
- Eingabezeiten verwenden die lokale Browser-Zeitzone. Die Zielauswahl startet die Berechnung automatisch, standardmäßig ab aktuellem Standort und jetzt. Manuelle Start-/Zeitvorgaben bleiben erhalten. Routenanpassungen bleiben Entwürfe bis zur Übernahme. Gültige Einstellungsänderungen werden sofort gespeichert, verwerfen aktuelle Ergebnisse und lösen beim Verlassen eine neue Berechnung aus. Aktualisierung, Abbruch und neue Planung verhindern verspätete Antworten; fehlgeschlagene Aktualisierungen erhalten vorherige Ergebnisse.
- Keine Navigation, keine Übergabe an die App und keine laufende Aktualisierung einer bereits angezeigten Verbindung. Echtzeitinformationen entsprechen dem Zeitpunkt der Abfrage.

## Zwischenziele und Planungslinks

Die [gemeinsamen Zwischenzielregeln](../documentation/bedienung.md#zwischenziele) gelten auch im Web; die PWA bietet weiterhin keine Navigation. Es werden nur vollständige Reisen durch alle Stopps angezeigt. Pausen gehören zur Gesamtzeit, das Radlimit gilt je Teilstrecke. Anfrage- und Zeitgrenzen beschreibt die [Routingdokumentation](../documentation/routing.md#planung-mit-zwischenzielen).

Planungslinks ohne Stopps verwenden `v=1`. Links mit Zwischenzielen verwenden `v=2` und geordnete Parameter `via1`, `via1Name`, `via1Stay` bis `via3`, `via3Name`, `via3Stay` (Koordinaten, Name, Aufenthalt in Minuten). Ungültige oder unvollständige Stoppangaben verhindern die Berechnung. Browserhistorie, Kopieren und Offline-Snapshots behalten Stopps und Aufenthalte bei. Wie bisher sind Einstellungen aus einem Link vorübergehend und überschreiben keine persönlichen Voreinstellungen.

## Vor öffentlicher Veröffentlichung

Der Build veröffentlicht nichts. Vor öffentlichem Start die erwartete Nutzung einschließlich zusätzlicher Routinganfragen mit Transitous abstimmen und Kontaktadresse prüfen. Die Nutzungsbedingungen erlauben nicht pauschal beliebige Routinglast. Referer, Datenquellen und Kartenattribution bleiben sichtbar bzw. aktiviert. Für größere Nutzung ist ein abgestimmtes Dienstangebot oder eigene Routinginfrastruktur erforderlich.

Die Website-Ausgabe liegt unter `docs/`. Für GitHub Pages kann nach separat beschlossener Veröffentlichung eine Branch-Quelle mit diesem Verzeichnis eingerichtet werden; Verfügbarkeit und Repository-Voraussetzungen anhand der [GitHub-Anleitung](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) prüfen. Ein lokaler Build oder Vorschau-Server veröffentlicht keine Dateien.

Quellen:

- [Transitous API und Nutzung](https://transitous.org/api/)
- [MOTIS API-Spezifikation](https://github.com/motis-project/motis/blob/v2.10.2/openapi.yaml)
- [Leaflet 1.9.4](https://leafletjs.com/reference.html)
- [OpenStreetMap Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)

Leaflet ist unter BSD-2-Clause lizenziert; siehe `public/leaflet-LICENSE.txt`. Karten und Routingdaten besitzen eigene Quellen und Nutzungsbedingungen.


## App-Oberfläche und PWA

- Zielsuche als Einstieg, danach Karte mit dunklem Routenpanel. Die normale Übersicht passt ihre Höhe an Zeiten, Dauer, Verbindungsauswahl und Hinweise an. Etappen erscheinen erst unter „Mehr Details“; „Weniger Details“ kehrt zur Übersicht zurück. Kartenberührung oder Ziehen nach unten minimiert das Panel, „Übersicht öffnen“ stellt die normale Ansicht wieder her. Kopfzeile und Aktionen bleiben fest erreichbar. Nur in der Detailansicht oder bei zu wenig Platz (Querformat, große Schrift, lange Hinweise) scrollt der gemeinsame Inhaltsbereich; das Panel selbst und einzelne Hinweise haben keine eigenen Scrollbereiche. Ab 900 px steht das 420 px breite Panel links über der Karte.
- Kartenmarker unterscheiden Start (dunkler Punkt mit weißem Ring), Ziel (gelbe Flagge) und Zwischenstopps (gelbe Nummern in Reisereihenfolge). Antippen oder Tastaturaktivierung öffnet Rolle und Ortsname. Identische Koordinaten teilen einen Marker mit allen Symbolen und Ortsangaben. Die Darstellung gilt auch für gespeicherte Offline-Reisen.
- Alternativen folgen wie iOS frühester Ankunft beziehungsweise spätester Abfahrt bei Ankunftsvorgabe. Wischen über die Zusammenfassung, Links/Rechts-Tasten oder Auswahlschaltflächen wechseln die Verbindung. Nachgeladene bessere Ergebnisse werden automatisch ausgewählt, solange keine manuelle Auswahl erfolgte.
- Die Ortssuche startet ab zwei Zeichen nach 280 Millisekunden Eingabepause und zeigt bis zu zwölf Transitous-Vorschläge. Vorhandene aktuelle Standortdaten gewichten die Suche regional; sonst dient München als Bezug, ohne andere Städte auszuschließen. Apple und Transitous können unterschiedliche Treffer liefern.
- Startseite sowie Start- und Zielauswahl zeigen Favoriten alphabetisch und bis zu fünf zuletzt verwendete Nicht-Favoriten. Bis zu 20 Nicht-Favoriten werden gespeichert. Auswahl zählt auch bei anschließenden Planungsfehlern; Favorisieren allein zählt nicht als Nutzung. Gleiche Namen innerhalb von 25 Metern werden zusammengeführt. „Aktueller Standort“ bleibt eine eigene Aktion und wird nicht favorisiert oder als fester Ort gespeichert.
- Stern, Ortsauswahl und ↖-Pfeil sind getrennte Aktionen. Der Pfeil übernimmt den Namen mit Leerzeichen und setzt den Cursor ans Ende; erst weitere Eingabe oder „Suchen“ lädt erneut. Favoriten und letzte Orte lassen sich auch offline ansehen. „Alle lokalen Daten löschen“ entfernt nach Bestätigung Orte, Einstellungen und den Fahrtenverlauf.
- Abfahrt und Ankunft stehen gleichwertig in der Kopfzeile. Nach Suchende erscheint ab 60 Minuten späterem Start ein Hinweis mit Zugang zu Einstellungen. Maßgeblich ist der ursprüngliche Anfragezeitpunkt; Ankunftssuchen und gespeicherte Reisen zeigen diesen Hinweis nicht.
- „Route anpassen“ bearbeitet Start, bis zu drei Zwischenziele, Ziel und Zeit als Entwurf. Zwischenziele lassen sich umordnen und mit 0–1440 Minuten Aufenthalt versehen. Beim Umkehren der Route kehrt sich ihre Reihenfolge mit um. „Aktuellen Standort verwenden“ fragt sofort den Standort und gegebenenfalls die Berechtigung ab. Nach Zielauswahl beziehungsweise beim bewussten Berechnen wird der Standort erneut ermittelt. Bei verweigertem Zugriff zeigt die App Hinweise zu Geräte- und Browsereinstellungen; eine gespeicherte Ablehnung kann sie nicht selbst zurücksetzen. Der separate Kartenknopf ändert nur den Kartenausschnitt.
- „Einstellungen“ speichert jede gültige Änderung. Die aktuelle Planung wird sofort verworfen; beim Verlassen über „Fertig“, Routentab oder Browser-Zurück wird einmal mit den letzten Werten neu berechnet. Fehler bieten Aktualisierung und Anpassung; verworfene Ergebnisse kehren nicht zurück. Die alte Offline-Reise bleibt unabhängig davon als gespeicherter Stand erhalten.
- PWA-Build mit `vite-plugin-pwa` 1.3.0. Manifest und Service Worker liegen unter `plan/`, beide verwenden relative Pfade. Der Service Worker verwaltet nur diesen Bereich. Hashes innerhalb desselben Pfads benötigen keine Server-Rewrites.
- Nur lokale HTML-, JS-, CSS- und Icon-Ressourcen werden vorgeladen. Keine zusätzliche Speicherung oder Vorabdownloads von Transitous-Antworten und OSM-Kacheln. Die normale HTTP-Cache-Steuerung des Kartenanbieters bleibt bestehen.
- IndexedDB `foldroute-offline`, Version 2: Store `state` enthält `enabled`, den Verlauf `history` (Version 1) und den neuesten Snapshot `last`; Store `places` enthält Favoriten und letzte Orte. Reise-Snapshots ohne Zwischenziele verwenden Version 3, mit Zwischenzielen Version 4; Versionen 1 und 3 bleiben mit damaligen Einstellungen und unveränderten Zeiten lesbar. Speicheraktionen verwenden Transaktionen; Ausschalten leert `history`, löscht `last` und verhindert weitere automatische Reisespeicherung; Favoriten und letzte Orte bleiben erhalten. Ungültige gespeicherte Daten werden entfernt. Speicherfehler blockieren die Online-Planung nicht.
- Einstellungen liegen unter `foldroute.routing.v3` in `localStorage`. Der ältere Schlüssel `foldroute.routing.v1` wird nach erfolgreicher Migration entfernt.
- Der Tab „Fahrten“ zeigt die letzten 20 unterschiedlichen Strecken, neueste zuerst. Es sind geplante Reisen, keine automatisch erkannten abgeschlossenen Fahrten. Gleiche Start- und Zielorte mit denselben geordneten Zwischenzielen teilen einen Eintrag. Neue erfolgreiche Berechnungen ersetzen dessen gespeicherten Stand und rücken ihn nach oben. Abfragezeit, Einstellungen, Aufenthaltsdauer und gewählte Alternative unterscheiden keine Strecken. Ortsnamen werden unabhängig von Großschreibung innerhalb von 25 Metern verglichen; generische Standortnamen werden nur über die Nähe zugeordnet. Die Liste zeigt Start → Ziel und gegebenenfalls Zwischenziele; Zeiten bleiben in den gespeicherten Details. Stabile Eintragskennungen und separate Berechnungskennungen verhindern, dass verspätete Ergebnisse neuere Stände überschreiben.
- Öffnen zeigt den gespeicherten Stand ohne neue Routen- oder Standortabfrage, auch offline. „Jetzt neu planen“ verwendet gespeicherte Startkoordinaten, Ziel, Zwischenziele und Aufenthalte mit Abfahrt jetzt. Die damaligen Routing-Einstellungen gelten vorübergehend und überschreiben keine persönlichen Einstellungen. „Route anpassen“ erlaubt Änderungen.
- „Fahrten auf diesem Gerät speichern“ ist standardmäßig eingeschaltet. Ausschalten löscht den Verlauf; einzelne Fahrten lassen sich im Tab löschen, der gesamte Verlauf nach Bestätigung in den Einstellungen. Die vorhandene Einzelreise wird beim ersten Zugriff einmalig übernommen. Der versionierte Verlauf liegt unter `state.history` in der bestehenden IndexedDB-Datenbank; `state.last` bleibt als neuester Snapshot erhalten. Vorhandene Streckenduplikate werden beim Lesen zusammengeführt und atomar gespeichert; der neueste gültige Stand bleibt erhalten. Beschädigte Einträge werden einzeln entfernt. Parallele Schreibvorgänge begrenzen den Verlauf atomar auf 20 Einträge.
- Offline-Neustart öffnet die letzte Reise als gespeicherten Stand. Die Kartenfläche zeigt nur die gespeicherte Geometrie auf neutralem Hintergrund. Zeiten werden nicht als aktuelle Echtzeitdaten dargestellt. Ohne gespeicherte Reise bleibt ein erklärter Leerzustand. Netzrückkehr startet keine Berechnung.
- Updates zeigen „Neue Version verfügbar“. Erst „Aktualisieren“ aktiviert den wartenden Service Worker und lädt neu. Während einer Berechnung oder eines Anpassungsdialogs ist die Updateaktion gesperrt. „Später“ erhält die laufende Ansicht.
- Die Icons wurden aus `public/app-icon.svg` mit dem PWA Assets Generator 1.0.2 erzeugt (Preset `minimal`, `resizeOptions.background: '#171A1C'` für `maskable` und `apple`). Der Generator war nur für diesen einmaligen Exportschritt installiert; die PNGs und das SVG liegen im Repository.

Installation funktioniert auf HTTPS oder lokal auf `localhost`/`127.0.0.1`. Ein HTTP-Link mit einer LAN-IP reicht für eine vollständige PWA-Prüfung auf dem iPhone nicht aus. In Safari über Teilen → „Zum Home-Bildschirm“ installieren; falls angeboten, „Als Web-App öffnen“ aktivieren. Die Einstellungen zeigen diese Anleitung beziehungsweise den unterstützten Browser-Installationsdialog. Ein Browser kann gespeicherte Daten wieder entfernen; Offline-Verfügbarkeit setzt einen zuvor erfolgreichen Online-Aufruf voraus.

Vor Veröffentlichung auf einem echten iPhone prüfen: Installation und Icon, eigenständiges Fenster, Safe Areas, Tastatur bei Ortssuche und Anpassung, Offline-Neustart sowie Updateübernahme. Automatisierte Chromium- und WebKit-Tests decken diese Geräteeigenschaften nicht vollständig ab.
