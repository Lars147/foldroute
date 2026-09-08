# FoldRoute Webplaner

[Projektübersicht](../README.md) · [Routingdetails und Plattformgrenzen](../documentation/routing.md)

Browserbasierte Routenplanung für Faltrad und ÖPNV. Vite/TypeScript, Leaflet und direkte Transitous-Anfragen; kein eigener Server, keine Konten, keine Analyse-Tools. Gültige Routing-Einstellungen werden in `localStorage` gespeichert. Optional bleibt genau die zuletzt gewählte Reise einschließlich Start, Ziel, Etappen, Geometrie und Abfragezeit in IndexedDB. Keine Suchhistorie oder GPS-Spuren.

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

Die folgenden Befehle werden in `web/` ausgeführt. Die Browsertests benötigen die Ports 4173 und 4174 exklusiv; vorher eigene Vorschauprozesse auf diesen Ports beenden. Ihr Testserver liefert das Repository-Hauptverzeichnis aus, weshalb der interne Testpfad `/docs/plan/` von der obigen Website-Vorschau abweicht.

```sh
npm run test:parity
npx playwright install chromium webkit
npm run build
npm run test:browser
```

Die Browsertests benötigen zusätzlich Python 3 für den statischen Testserver. Service-Worker-Tests laufen auf dem fertigen Build unter einem Unterpfad. Der Paritätstest benötigt macOS und Swift. Er kompiliert die unveränderten nativen Routingdateien aus `../ios/` und führt sie mit `URLProtocol`-Testantworten aus, ohne Netzwerkzugriff. `tests/fixtures/swift-parity.json` enthält dieselben normalisierten Transitous-Antworten und native Referenzergebnisse. Vitest vergleicht daraus Abfahrten, Ankünfte, Etappen, Faltzeiten und Auswahl. Nach bewussten nativen Änderungen: `sh scripts/parity.sh --update`; anschließend die Referenzänderungen prüfen. Der Harness ersetzt ausschließlich den für Routing irrelevanten Typ `NavigationProgress`.

Zusätzliche Tests prüfen Anfrageparameter, Ausschlüsse, Geometrie, Zeitvorteil, Vorwärts-/Rückwärts-Verknüpfung, Teilergebnisse, Abbruch und Rate-Limits. Browsertests verwenden abgefangene API-Anfragen und keine echten Routingdienste. Screenshots entstehen für 320, 390, 768 und 1479 Pixel Breite. Das sind gezielte Paritätsfälle, kein Beweis identischer Ergebnisse für alle denkbaren Netze und Datenfehler. Der Vergleich verwendet ausdrücklich identische Falt- und Entfaltzeiten von jeweils 180 Sekunden; die Standardwerte beider Oberflächen können abweichen. Die browserseitige Distanzprüfung verwendet Haversine, die App CoreLocation; Grenzfälle direkt an Abstandstoleranzen können abweichen.

## Routing und Grenzen

- Direkte Radroute sowie vier Kombinationen aus Rad-/Fuß-Zubringer und -Abbringer.
- Konfigurierbare Geschwindigkeit, Zugangszeiten, Falt-/Entfaltzeiten, Verkehrsmittel und zusätzliche Radverbindungen zwischen Linien.
- Progressive Ergebnisse; maximal drei sichtbare Alternativen. Die ausgewählte Reise bleibt beim Nachladen ausgewählt.
- Maximal zwei gleichzeitige Routinganfragen. Zusätzliche Rad-Umstiege: höchstens vier Anfragen je Tiefe, maximal drei Tiefen und insgesamt 15 Sekunden Suchbudget. Geometriefehler werden einmal erneut abgefragt; HTTP-Fehler werden nicht automatisch wiederholt.
- Falten und Entfalten sind getrennt einstellbar: Standard 180 bzw. 120 Sekunden. Falten erlaubt 60–600, Entfalten 30–600 Sekunden, jeweils in 30-Sekunden-Schritten. iOS verwendet dagegen eine gemeinsame Dauer für beide Vorgänge.
- HTTP 429 und lesbare `Retry-After`-Angaben bei 429/503 stoppen weitere Planung. Eine laufende zweite Anfrage kann beim Eintreffen bereits unterwegs sein. Ohne CORS-Freigabe des Headers kennt der Browser keine exakte Wartefrist.
- Eingabezeiten verwenden die lokale Browser-Zeitzone. Die Zielauswahl startet die Berechnung automatisch, standardmäßig ab aktuellem Standort und jetzt. Manuelle Start-/Zeitvorgaben bleiben erhalten. Routen- und Einstellungsänderungen sind Entwürfe bis zur Übernahme. Aktualisierung, Abbruch und neue Planung verhindern verspätete Antworten; fehlgeschlagene Aktualisierungen erhalten vorherige Ergebnisse.
- Keine Navigation, keine Übergabe an die App und keine laufende Aktualisierung einer bereits angezeigten Verbindung. Echtzeitinformationen entsprechen dem Zeitpunkt der Abfrage.

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

- Zielsuche als Einstieg, danach Karte mit dunklem Routenpanel. Mobil: kompakt, normal und erweitert; Griff, Schaltfläche und Tastatur bleiben bedienbar. Ab 900 px steht das 420 px breite Panel links über der Karte.
- Alternativen stehen nach Gesamtdauer sortiert. Wischen über die Zusammenfassung, Links/Rechts-Tasten oder Auswahlschaltflächen wechseln die Verbindung. Nachgeladene Ergebnisse ändern die Auswahl nicht.
- „Route anpassen“ bearbeitet Start, Ziel und Zeit als Entwurf. „Aktueller Standort“ wird erst nach Zielauswahl beziehungsweise beim bewussten Berechnen ermittelt. Der separate Kartenknopf ändert nur den Kartenausschnitt.
- „Einstellungen“ übernimmt Änderungen ausdrücklich; bei vorhandener Route wird anschließend neu berechnet. Die Navigation während der Fahrt bleibt in der iPhone-App.
- PWA-Build mit `vite-plugin-pwa` 1.3.0. Manifest und Service Worker liegen unter `plan/`, beide verwenden relative Pfade. Der Service Worker verwaltet nur diesen Bereich. Hashes innerhalb desselben Pfads benötigen keine Server-Rewrites.
- Nur lokale HTML-, JS-, CSS- und Icon-Ressourcen werden vorgeladen. Keine zusätzliche Speicherung oder Vorabdownloads von Transitous-Antworten und OSM-Kacheln. Die normale HTTP-Cache-Steuerung des Kartenanbieters bleibt bestehen.
- IndexedDB `foldroute-offline`, Version 1, Store `state`: `enabled` und genau ein versionierter `last`-Datensatz. Speicheraktionen verwenden Transaktionen; Ausschalten löscht `last` und verhindert weitere automatische Speicherung. Ungültige gespeicherte Daten werden entfernt. Speicherfehler blockieren die Online-Planung nicht.
- Offline-Neustart öffnet die letzte Reise als gespeicherten Stand. Die Kartenfläche zeigt nur die gespeicherte Geometrie auf neutralem Hintergrund. Zeiten werden nicht als aktuelle Echtzeitdaten dargestellt. Ohne gespeicherte Reise bleibt ein erklärter Leerzustand. Netzrückkehr startet keine Berechnung.
- Updates zeigen „Neue Version verfügbar“. Erst „Aktualisieren“ aktiviert den wartenden Service Worker und lädt neu. Während einer Berechnung oder eines Anpassungsdialogs ist die Updateaktion gesperrt. „Später“ erhält die laufende Ansicht.
- Die Icons wurden aus `public/app-icon.svg` mit dem PWA Assets Generator 1.0.2 erzeugt (Preset `minimal`, `resizeOptions.background: '#171A1C'` für `maskable` und `apple`). Der Generator war nur für diesen einmaligen Exportschritt installiert; die PNGs und das SVG liegen im Repository.

Installation funktioniert auf HTTPS oder lokal auf `localhost`/`127.0.0.1`. Ein HTTP-Link mit einer LAN-IP reicht für eine vollständige PWA-Prüfung auf dem iPhone nicht aus. In Safari über Teilen → „Zum Home-Bildschirm“ installieren; falls angeboten, „Als Web-App öffnen“ aktivieren. Die Einstellungen zeigen diese Anleitung beziehungsweise den unterstützten Browser-Installationsdialog. Ein Browser kann gespeicherte Daten wieder entfernen; Offline-Verfügbarkeit setzt einen zuvor erfolgreichen Online-Aufruf voraus.

Vor Veröffentlichung auf einem echten iPhone prüfen: Installation und Icon, eigenständiges Fenster, Safe Areas, Tastatur bei Ortssuche und Anpassung, Offline-Neustart sowie Updateübernahme. Automatisierte Chromium- und WebKit-Tests decken diese Geräteeigenschaften nicht vollständig ab.
