# iPhone-Prototyp entwickeln

[Projektübersicht](../README.md) · [Bedienung](../documentation/bedienung.md) · [Routingdetails](../documentation/routing.md)

Alle Shell-Befehle und Projektpfade dieser Anleitung beziehen sich auf das **Repository-Hauptverzeichnis**, nicht auf `ios/`.

## Einrichten und starten

Voraussetzungen: Xcode 26 oder neuer, iOS 18 oder neuer, Apple-Entwicklerteam für ein physisches Gerät.

1. `ios/FoldRoute.xcodeproj` in Xcode öffnen.
2. Für ein physisches iPhone im Target **FoldRoute** unter **Signing & Capabilities** eigenes Team und eine eigene eindeutige Bundle-ID wählen. Das Projekt enthält kein festes Entwicklerteam; `com.example.FoldRoute` und `com.example.FoldRouteTests` sind neutrale Platzhalter.
3. iPhone oder kompatiblen Simulator auswählen und **Run** starten.

Kein API-Schlüssel und kein Backend nötig. Die App ist deutsch, metrisch und auf iPhone-Portrait optimiert. Eine fertige App-Store-Version steht noch nicht bereit.

Eine andere Bundle-ID installiert die App als separate Anwendung. Vorhandene lokale Daten der bisherigen Installation werden dabei nicht übernommen.

## Kartenansicht

„Gesamte Route anzeigen“ unter dem Standort-Button passt die ausgewählte Strecke mit Start, Ziel und Zwischenstopps wieder in den freien Kartenbereich ein. Panelmodus und Scrollposition bleiben erhalten. Die Aktion benötigt keine neue Standortabfrage oder Routenberechnung und funktioniert auch bei gespeicherten Reisen. Die laufende Navigation behält ihre eigene Standort-Zentrierung.

## Architektur

`AppModel` koordiniert den Ablauf. `TransitousClient` implementiert die austauschbare `JourneyPlanning`-Grenze und übersetzt MOTIS-Daten in eigene Domain-Modelle. `NavigationEngine` arbeitet nur auf diesen Modellen. `LocationService` liefert flüchtige GPS-Daten, `GuidanceService` Sprache/Haptik/Benachrichtigungen und `SwiftDataJourneyStore` lokale Persistenz.

Apple-Frameworks: SwiftUI, MapKit, Core Location, SwiftData, AVFoundation und UserNotifications. Keine Drittanbieterpakete.

Die Anwendung trennt externe DTOs von UI und Navigation. Fehler sollen früh und ausdrücklich behandelt werden. Änderungen an App-Code vor dem Merge mit einem passenden Geräte-/Simulator-Build und Tests prüfen.

## Konfiguration

- Kontaktkennung für Transitous: `TransitousContact` in `ios/FoldRoute/Info.plist`
- Bundle-ID und Version: Build Settings im App-Target
- Faltzeiten: in der App unter **Einstellungen → Klapprad**

## Tests

Unit-Tests prüfen Polyline-Decoding, MOTIS-Queries, Zeitverschiebungen für Falten/Entfalten, direkten Rad-Fallback, HTTP-Fehler, SwiftData-Roundtrips sowie Standortgrenzen und Anfahrts-Komposition. Zusätzlich prüfen sie zielbezogenen Verlauf, sofortige Planung mit aktuellem Standort, parallele Anfragen, unveränderte Routen nach fehlgeschlagenen Anpassungen und verspätete oder abgebrochene Suchantworten.

```sh
xcodebuild \
  -project ios/FoldRoute.xcodeproj \
  -scheme FoldRoute \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  test
```

Der Simulatorname ist ein Beispiel; eine lokal installierte passende Destination wählen. Fehlt eine iOS-Plattform, die passende Simulator-Runtime in Xcode installieren. Erfolgreiche frühere Läufe ersetzen keine Prüfung des aktuellen Codes.

## Manuelle Geräteabnahme

Diese fünf Fahrtentypen mit passenden Orten in der Testregion auf einem echten iPhone testen. Ziel: Route wird berechnet, alle Phasen stimmen zeitlich, Linien/Gleise sind plausibel, GPS-Fortschritt funktioniert und die Fahrt kann abgeschlossen werden.

1. Innenstadt → Stadtteilzentrum
2. Bahnhof → nahe gelegenes Ziel mit kurzem Fußweg
3. Wohnadresse → Ziel mit Rad-Anfahrt und ÖPNV
4. Innenstadt → Stadtrand mit Umstieg
5. Bahnhof → Ausflugsziel mit Radstrecke nach dem ÖPNV

Zusätzlich je eine Fahrt mit **Abfahrt**, **Ankunft**, direkter Radroute und absichtlicher Abweichung prüfen. Nicht während der Fahrt am Telefon bedienen.

Zusätzlich Standortfreigabe und GPS-Ausfall, Hintergrundwechsel, Wiederaufnahme, abgebrochene Suchen, Serverfehler sowie große Bedienungshilfe-Schrift prüfen. Diese Liste ist eine Abnahmevorgabe, kein Nachweis bereits absolvierter Feldtests.

## Daten und Grenzen

Beim Planen gehen Start, Ziel und Zeitpunkt direkt an [Transitous](https://transitous.org/api/). MapKit verarbeitet Ortssuchen. Für erneut planbare Fahrten speichert FoldRoute Start und Ziel lokal, aber keine GPS-Spur. Attributionen sind in den Einstellungen sichtbar; Kartendaten stammen unter anderem von [OpenStreetMap-Mitwirkenden](https://www.openstreetmap.org/copyright).

Speicher- und Migrationsregeln stehen in der [Routingdokumentation](../documentation/routing.md#speicherung-und-kompatibilität-ios). Vor einer breiten Veröffentlichung die [Betriebs- und Datenquellenhinweise](../web/README.md#vor-öffentlicher-veröffentlichung) beachten; sie betreffen auch die iOS-Anfragen an Transitous.
