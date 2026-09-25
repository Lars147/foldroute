# iPhone-Prototyp entwickeln

[Projektübersicht](../README.md) · [Bedienung](../documentation/bedienung.md) · [Routingdetails](../documentation/routing.md)

Alle Shell-Befehle und Projektpfade dieser Anleitung beziehen sich auf das **Repository-Hauptverzeichnis**, nicht auf `ios/`.

## Einrichten und starten

Voraussetzungen: ein Mac mit Xcode 26 oder neuer, iOS 18 oder neuer, Apple-Entwicklerteam für ein physisches Gerät.

1. Den [Quellcode als ZIP herunterladen](https://github.com/Lars147/foldroute/archive/refs/heads/main.zip) und entpacken. Alternativ das [öffentliche Repository](https://github.com/Lars147/foldroute) klonen.
2. Im entpackten beziehungsweise geklonten Ordner `ios/FoldRoute.xcodeproj` in Xcode öffnen.
3. Für ein physisches iPhone im Target **FoldRoute** unter **Signing & Capabilities** eigenes Team und eine eigene eindeutige Bundle-ID wählen. Das Projekt enthält kein festes Entwicklerteam; `com.example.FoldRoute` und `com.example.FoldRouteTests` sind neutrale Platzhalter.
4. iPhone oder kompatiblen Simulator auswählen und **Run** starten.

Kein API-Schlüssel und kein Backend nötig. Die App ist deutsch, metrisch und auf iPhone-Portrait optimiert. Eine fertige App-Store-Version steht noch nicht bereit.

Eine andere Bundle-ID installiert die App als separate Anwendung. Vorhandene lokale Daten der bisherigen Installation werden dabei nicht übernommen.

## Kartenansicht

„Alle Routen anzeigen“ unter dem Standort-Button passt alle angebotenen Alternativen mit Start, Ziel und Zwischenstopps in den freien Kartenbereich ein; bei einer Verbindung heißt die Aktion „Gesamte Route anzeigen“. Panelmodus und Scrollposition bleiben erhalten. Die Aktion benötigt keine neue Standortabfrage oder Routenberechnung und funktioniert auch bei gespeicherten Reisen. Die laufende Navigation behält ihre eigene Standort-Zentrierung.

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

Beim Planen gehen Start, Ziel, gewählte Zwischenziele, Zeitpunkt und Routing-Einstellungen direkt an [Transitous](https://transitous.org/api/). MapKit verarbeitet Ortssuchen. Einstellungen, Favoriten, letzte Orte und erneut planbare Fahrten einschließlich ihrer Zwischenziele bleiben lokal; FoldRoute speichert keine GPS-Spur. Attributionen sind in den Einstellungen sichtbar; Kartendaten stammen unter anderem von [OpenStreetMap-Mitwirkenden](https://www.openstreetmap.org/copyright).

Speicher- und Migrationsregeln stehen in der [Routingdokumentation](../documentation/routing.md#speicherung-und-kompatibilität-ios). Vor einer breiten Veröffentlichung die [Betriebs- und Datenquellenhinweise](../web/README.md#vor-öffentlicher-veröffentlichung) beachten; sie betreffen auch die iOS-Anfragen an Transitous.

Die Kartenübersicht bleibt beim Wechsel zwischen Alternativen stehen. Nachgeladene Umwege erweitern sie bei Bedarf; entfallene Alternativen verkleinern sie nicht automatisch. Eigenes Verschieben oder Zoomen pausiert automatische Anpassungen bis zur Übersichtsaktion oder einer neuen erfolgreichen Berechnung. Auch der eingeblendete Fahrradvergleich gehört zur gemeinsamen Übersicht.

### Live-Standort in der Routenvorschau

Die sichtbare Routenvorschau aktualisiert bei vorhandener Freigabe den blauen Standortpunkt und einen maßstabsgetreuen Genauigkeitskreis. Über 100 Meter wird die Position als ungenau bezeichnet; über 60 Sekunden alte Messungen oder Ortungsfehler zeigen den letzten Punkt grau. Der geplante Start und der Kartenausschnitt bleiben fest. Der Standortbutton zentriert einmalig, ohne anschließendes Mitführen.

Die Vorschauortung pausiert bei Tabwechsel, Routenbearbeitung und im Hintergrund. Aktive Navigation hat Vorrang und behält ihre bisherige Hintergrundortung und Kameraführung. Es werden keine GPS-Spuren gespeichert. Bewegung, Berechtigungswechsel und Bildschirmsperre müssen zusätzlich auf einem echten iPhone geprüft werden; Builds und simulierte Positionsfolgen ersetzen diesen Feldtest nicht.

Die lokale Einstellung „Bildschirm während der Route eingeschaltet lassen“ ist standardmäßig aktiv. Der Idle Timer wird nur für eine sichtbare Routenvorschau oder aktive Navigation im Vordergrund deaktiviert. Routenbearbeitung, andere Tabs und Hintergrundwechsel stellen das normale Verhalten wieder her. Die Einstellung liegt separat in UserDefaults und beeinflusst keine Routenberechnung.
