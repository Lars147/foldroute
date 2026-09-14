# FoldRoute

Dein Routenplaner für Faltrad und ÖPNV. FoldRoute kombiniert Rad, Bus und Bahn zu einer Reise: zum Bahnhof radeln, nach dem Aussteigen weiterfahren oder mit einer kurzen Radetappe zwischen zwei Linien wechseln. Falt- und Entfaltzeiten werden mitgerechnet. So lassen sich passende Verbindungen in der Stadt und über Land finden, abhängig von den verfügbaren Verkehrs- und Routingdaten.

## Projektstand

| Oberfläche | Aktueller Umfang |
|---|---|
| Webplaner / PWA | Routenplanung, Favoriten, letzte Orte, gemeinsame Routing-Einstellungen und bis zu 20 gespeicherte Strecken offline ansehen |
| iPhone-App | Nativer iOS-Prototyp mit Navigation, Abbiegehinweisen, Sprachansagen, Haptik und ÖPNV-Aktualisierungen während der Fahrt |

Die iPhone-App ist noch in Entwicklung und nicht im App Store. Im Webplaner kannst du jetzt Routen planen und ihn als App auf dem Home-Bildschirm installieren; die [Web-Anleitung](web/README.md#app-oberfläche-und-pwa) erklärt den Einstieg. Navigation in der PWA ist **noch nicht umgesetzt**. Gemeinsame Routing-Einstellungen und Auswahlregeln sind angeglichen. Ortssuchanbieter unterscheiden sich; automatische ÖPNV-Aktualisierungen während der Fahrt gehören zum iPhone-Prototyp. Beide Oberflächen bieten einen lokalen Fahrtenverlauf. Eine direkte Übergabe einer Webroute an die iPhone-App gibt es derzeit nicht.

## Lokal ausprobieren

Für den Webplaner werden Node.js 22.12 oder neuer und npm benötigt. Im Repository-Hauptverzeichnis:

```sh
cd web
npm ci
npm run dev
```

Danach den Webplaner unter [http://127.0.0.1:4173/](http://127.0.0.1:4173/) öffnen. Ein Ziel auswählen; standardmäßig wird ab aktuellem Standort für jetzt geplant. Für die Standortabfrage ist deine Freigabe nötig. Start und Zeitpunkt lassen sich manuell anpassen. Routen werden direkt über Transitous berechnet; ein eigener Backenddienst oder API-Schlüssel ist dafür nicht erforderlich.

Die Entwicklungsadresse zeigt direkt den Planer. Für Landingpage und gebauten Planer unter `/plan/` siehe [gesamte Website lokal ansehen](web/README.md#gesamte-website-lokal-ansehen). Die dort beschriebenen Schritte veröffentlichen nichts.

Für den iPhone-Prototyp öffne `ios/FoldRoute.xcodeproj` in Xcode. Voraussetzungen, Gerätesignierung und Testbefehle stehen in der [iOS-Anleitung](ios/README.md). Die Bedienung ist auf Deutsch, metrisch und für das iPhone gestaltet.

## Projektstruktur

- `ios/`: native App, Xcode-Projekt und Swift-Tests.
- `web/`: Webplaner, PWA, Build-Konfiguration und Webtests.
- `docs/`: Landingpage und gebauter Webplaner unter `plan/`; dieses Verzeichnis dient der Website-Auslieferung.
- `documentation/`: aktuelle Bedienungs- und technische Dokumentation.

## Dokumentation

- [Bedienung](documentation/bedienung.md): Suche, Favoriten, Routenauswahl, Einstellungen und Navigation im iPhone-Prototyp.
- [Routing und Datenverhalten](documentation/routing.md): Auswahlregeln, Rad-Umstiege, Suchbudgets, Geometrieprüfung, Echtzeit und Speicherkompatibilität.
- [iOS entwickeln und prüfen](ios/README.md): Einrichtung, Architektur, Konfiguration und Geräteabnahme.
- [Web entwickeln und PWA nutzen](web/README.md): lokale Vorschau, Build, Tests, Offline-Funktionen und Veröffentlichungshinweise.

## Daten und Grenzen

FoldRoute benötigt kein Konto, nutzt keine Analyse-Tools oder Cloud-Synchronisation und speichert keine GPS-Spuren. Routenplanung und Ortssuche übertragen jedoch Daten an externe Dienste, darunter Start, Ziel und gewählte Zwischenziele; Einzelheiten zu Datenquellen stehen in den Plattformanleitungen. Einstellungen, Favoriten und letzte Orte bleiben lokal. Der Webplaner speichert standardmäßig bis zu 20 unterschiedliche geplante Strecken einschließlich Zwischenzielen, Streckenverlauf und damaligen Zeiten. Ausschalten der Fahrten-Speicherung löscht diesen Verlauf; Orte und Einstellungen bleiben erhalten. „Alle lokalen Daten löschen“ entfernt sämtliche Kategorien. Eine gespeicherte Offline-Reise ist ein früherer Stand, keine aktuelle Verbindung; neue Routen, Ortssuche, aktuelle Verbindungsdaten und Straßenkarten benötigen Internet. Auch der Browser kann lokale Daten entfernen.

Verbindungen, Echtzeitinformationen und mögliche Zeitvorteile hängen von Strecke, Fahrplan und Datenabdeckung ab. Die zusätzliche Suche nach Rad-Umstiegen ist begrenzt und garantiert kein globales Optimum. Transitous ist ein Best-Effort-Dienst; vor breiter Veröffentlichung müssen Nutzung und Betrieb geklärt werden.

Ticketkauf, Offline-Karten, Apple Watch, CarPlay, Indoor-Navigation und Fahrrad-Hardware sind nicht enthalten. Der Prototyp benötigt weitere praktische Erprobung. Der Quellcode ist im [öffentlichen GitHub-Repository](https://github.com/Lars147/foldroute) verfügbar. Der iPhone-Prototyp lässt sich mit der [Bauanleitung](ios/README.md) selbst starten.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Karten und Routingdaten haben eigene Quellen und Nutzungsbedingungen; diese stehen in der [Web-Anleitung](web/README.md#vor-öffentlicher-veröffentlichung).
