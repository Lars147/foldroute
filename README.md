# FoldRoute

Dein Routenplaner für Faltrad und ÖPNV. FoldRoute kombiniert Rad, Bus und Bahn zu einer Reise: zum Bahnhof radeln, nach dem Aussteigen weiterfahren oder mit einer kurzen Radetappe zwischen zwei Linien wechseln. Falt- und Entfaltzeiten werden mitgerechnet. So lassen sich passende Verbindungen in der Stadt und über Land finden, abhängig von den verfügbaren Verkehrs- und Routingdaten.

## Projektstand

| Oberfläche | Aktueller Umfang |
|---|---|
| Webplaner / PWA | Routenplanung direkt im Browser, anpassbare Einstellungen und auf Wunsch die letzte Reise offline ansehen |
| iPhone-App | Nativer iOS-Prototyp mit Navigation, Abbiegehinweisen, Sprachansagen, Haptik und ÖPNV-Aktualisierungen während der Fahrt |

Die iPhone-App ist noch in Entwicklung und nicht im App Store. Navigation in der PWA ist **noch nicht umgesetzt**. Web und iPhone-App unterscheiden sich auch bei einzelnen Einstellungen und deren Standardwerten. Eine direkte Übergabe einer Webroute an die iPhone-App gibt es derzeit nicht.

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

FoldRoute benötigt kein Konto, nutzt keine Analyse-Tools oder Cloud-Synchronisation und speichert keine GPS-Spuren. Routenplanung und Ortssuche übertragen jedoch Daten an externe Dienste; Einzelheiten zu lokalen Speichern und Datenquellen stehen in den Plattformanleitungen. Einstellungen bleiben lokal. Eine gespeicherte Offline-Reise ist ein früherer Stand, keine aktuelle Verbindung; neue Routen und Straßenkarten benötigen Internet.

Verbindungen, Echtzeitinformationen und mögliche Zeitvorteile hängen von Strecke, Fahrplan und Datenabdeckung ab. Die zusätzliche Suche nach Rad-Umstiegen ist begrenzt und garantiert kein globales Optimum. Transitous ist ein Best-Effort-Dienst; vor breiter Veröffentlichung müssen Nutzung und Betrieb geklärt werden.

Ticketkauf, Offline-Karten, Apple Watch, CarPlay, Indoor-Navigation und Fahrrad-Hardware sind nicht enthalten. Der Prototyp benötigt weitere praktische Erprobung. Das Repository `Lars147/foldroute` bleibt vorerst privat; eine öffentliche Bereitstellung wird separat eingerichtet.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Karten und Routingdaten haben eigene Quellen und Nutzungsbedingungen; diese stehen in der [Web-Anleitung](web/README.md#vor-öffentlicher-veröffentlichung).
