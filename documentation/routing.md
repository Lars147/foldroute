# Routing und Datenverhalten

[Projektübersicht](../README.md) · [Bedienung](bedienung.md)

Die folgenden Detailregeln beschreiben die **iOS-Implementierung**. Der Webplaner portiert wesentliche Planungsregeln; gezielte Paritätstests prüfen gemeinsame Fälle, aber keine vollständige Gleichheit. Web-spezifische Grenzen, insbesondere CORS und fehlende Navigation, stehen in der [Web-Anleitung](../web/README.md#routing-und-grenzen).

## Basisplanung und Auswahl

Die Basisberechnung verwendet höchstens fünf Anfragen und maximal zwei gleichzeitig. Ergebnisse erscheinen schrittweise. Bei Abfahrt entscheidet die früheste Gesamtankunft, bei Ankunftsvorgabe die späteste Abfahrt. Gleichstände werden nach weniger ÖPNV-Umstiegen, weniger Radetappen, kürzerer Radstrecke und kürzerem Fußweg aufgelöst. Varianten derselben konkreten ÖPNV-Fahrt werden zusammengefasst. Eine ausdrücklich ausgewählte Route bleibt bei späteren Ergebnissen erhalten. Bei Teilfehlern bleiben gefundene Verbindungen nutzbar; eine Ratenbegrenzung stoppt weitere Anfragen.

## Nutzen der ÖPNV-Alternativen

ÖPNV-Verbindungen werden vor der Kartenauswahl mit der zeitlich besten direkten Radroute verglichen. Sie müssen mindestens **3 Minuten sparen** oder **mindestens 20 % und mindestens 1 km Radstrecke sparen**, bei höchstens **10 Minuten zusätzlicher Reisezeit**. Bei Ankunftsvorgabe zählt entsprechend die spätere mögliche Abfahrt bzw. höchstens zehn Minuten frühere Abfahrt. Falten, Entfalten und Wartezeiten sind in den Gesamtzeiten enthalten. Bewertet wird die gesamte Reise; kurze Einzelabschnitte sind nicht pauschal ausgeschlossen.

Ungeeignete Verbindungen werden nicht als zusätzliche Karten aufgefüllt. ÖPNV-Ergebnisse erscheinen erst, wenn die parallel gestartete Radabfrage abgeschlossen ist; fehlt eine Radreferenz, bleibt die bisherige ÖPNV-Auswahl verfügbar. Die Bewertung benötigt keine zusätzlichen Anfragen. Rohkandidaten bleiben für die Suche nach besseren Rad-Umstiegen erhalten, deren fertige Gesamtrouten denselben Filter durchlaufen. Schwellenwerte sind vorerst fest und ändern keine Einstellungen oder bereits laufende Navigation.

## Rad-Umstiege

Die Suche funktioniert vorwärts bei Abfahrt und rückwärts bei Ankunft. Sie verwendet Ein- und Ausstiegspunkte bereits gefundener Verbindungen: höchstens drei Kandidaten je Stufe, vier zusätzliche Anfragen je Stufe, zwei gleichzeitig und insgesamt 15 Sekunden Nachsuche. Sie durchsucht nicht alle Haltestellen oder denkbaren Kombinationen und garantiert daher kein globales Optimum. Ein Rad-Umstieg erscheint nur, wenn eine passende Kombination gefunden wird und sie in die ausgewählten Alternativen fällt.

Zusammengesetzte Routen behalten Fahrtkennungen für Echtzeitaktualisierung und Wiederherstellung. Anschlussprüfungen berücksichtigen interne Radetappen, Faltzeiten und den verbleibenden Puffer.

Die zusätzlichen Übergänge enthalten Entfalten, Radfahrt, Falten und einen Anschlusspuffer von 180 Sekunden. Einstellbare Grenzen für die Radfahrt stehen in der [Bedienungsanleitung](bedienung.md#radetappen-zwischen-linien).

## Navigationsstart (iOS)

Beim Start nutzt FoldRoute nur Standorte, die höchstens 60 Sekunden alt und auf höchstens 100 Meter genau sind. Unter 250 Meter Entfernung startet die geplante Route direkt. Bis 25 Kilometer wird eine gestrichelt dargestellte Rad-Anfahrt zum ursprünglichen Start vorgeschaltet. Ist ein Anschluss dadurch nicht mehr erreichbar, plant FoldRoute automatisch die nächste Verbindung. Bei größerer Entfernung bleibt Navigation gesperrt und bietet **Route ab hier planen** an.

## Echtzeit während der Navigation (iOS)

Bei aktiver Navigation werden aktuelle und verbleibende ÖPNV-Fahrten beim Start und anschließend etwa alle 60 Sekunden über Transitous `/api/v6/trip` aktualisiert. Fahrtkennung, Haltestellenkennungen und ursprüngliche Ereigniszeiten identifizieren die gewählten Ein- und Ausstiege. Zeiten und Gleise aktualisieren sich ohne Zurücksetzen des Navigationsfortschritts. Die Anzeige unterscheidet Echtzeit, Fahrplan, fehlgeschlagenen Abruf und nicht verfügbare Aktualisierung samt letztem erfolgreichen Abrufzeitpunkt.

Ausfälle und gefährdete Anschlüsse lösen einen Hinweis und einen Vorschlag für eine neue Verbindung aus. Der Wechsel benötigt eine Bestätigung. Im Zug beginnt die Alternative am vorgesehenen Ausstieg und erhält den aktuellen Abschnitt; bei einem als ausgefallen gemeldeten aktuellen Halt muss der tatsächliche Ausstieg zunächst vor Ort geprüft und bestätigt werden. Bei anderen Abschnitten wird ab aktuellem Standort geplant. Abgelehnte Vorschläge ändern die aktive Verbindung nicht.

Fehler behalten die letzte Route bei. Wiederholungen erfolgen nach 2, 4 und anschließend 5 Minuten; längere `Retry-After`-Vorgaben werden eingehalten. Veraltete oder ausgefallene ÖPNV-Daten beenden keinen Navigationsabschnitt allein anhand der Uhrzeit. Lokale Erinnerungen werden bei Änderungen ersetzt, abgeschlossene und unzuverlässige Abschnitte werden ausgelassen. Ältere gespeicherte Fahrten ohne Kennungen bleiben nutzbar und bieten eine Neuberechnung an.

Hintergrundaktualisierung nutzt die vorhandene Standortnavigation; iOS garantiert keine exakten Intervalle. Bei Rückkehr in den Vordergrund werden fällige Abfragen nachgeholt. Während vollständiger App-Beendigung finden keine Abfragen statt. Datenabdeckung und Aktualität hängen von den Verkehrsunternehmen und Transitous ab.

## Prüfung der Streckengeometrie

Rad- und Fußabschnitte werden vor Übernahme als Routenergebnis geprüft: geografisch gültige Punkte, passende Endpunkte und zusammenhängende Abbiegeschritte (100 Meter Toleranz). Fehlende Linien werden aus gültigen Schrittgeometrien zusammengesetzt; nur Fußverbindungen bis 100 Meter dürfen ohne diese Daten auskommen. Lange gerade Kanten allein gelten nicht als Fehler. ÖPNV-Geometrien werden nicht nach diesen Straßenregeln bewertet.

Bei fehlerhaften Daten erfolgt höchstens eine zusätzliche Anfrage ohne lokalen Antwortcache. Direkte Radrouten mit Ankunftsvorgabe werden dabei anhand ihrer berechneten Abfahrt vorwärts neu gesucht. Ein Ersatz muss die Ankunftsvorgabe einhalten; seine Zeiten werden nicht nachträglich verschoben. Gültige Alternativen bleiben erhalten, weiterhin fehlerhafte Ergebnisse werden verworfen. Ohne gültiges Ergebnis erscheint eine Fehlermeldung. Navigation und Wiederaufnahme prüfen die verwendeten Straßenabschnitte ebenfalls.

Aufzugsschritte mit 0 Metern dürfen ohne eigene Liniengeometrie geliefert werden. Ihre angrenzenden Wegpunkte müssen innerhalb von 25 Metern liegen; dann erhält der Schritt einen Ankerpunkt, während „Aufzug nehmen“ erhalten bleibt. Zusammenhängende Gruppen solcher Schritte werden gemeinsam geprüft. Die Ausnahme gilt nicht für leere gewöhnliche Weg- oder Treppenschritte und löst keine Reparaturanfrage aus. Normalisierte Ankerpunkte werden mit der Route gespeichert und bei Wiederaufnahme weiterverwendet.

Bestätigte Haltestellen-Endpunkte mit einer nicht leeren Routingdienst-ID erlauben bis zu 500 Meter Abstand zwischen Haltestellenpunkt und Linien-/Schrittende. Adressen und aktuelle Standorte ohne Haltestellenkennung verwenden weiterhin 100 Meter. Das kennzeichnet nur eine plausible Zuordnung; es ergänzt weder eine Wegstrecke noch Reisezeit und ändert keine automatische Ankunftserkennung. Die optionale Haltestellen-ID wird im Ort gespeichert und bleibt bei Routenänderungen und Wiederaufnahme erhalten. Alte Orte ohne ID bleiben lesbar. Weglücken bleiben auf 100 Meter, Aufzugsanschlüsse auf 25 Meter begrenzt. Die lokale Log-Kategorie `StreetGeometry` protokolliert größere Endpunktabweichungen und Ablehnungen mit Abstand und Grenze, ohne Namen, IDs oder Koordinaten.

## Fehler und Serverpausen

Die Übersicht nennt konkrete Ursachen: fehlendes Netz, Zeitüberschreitung einer Anfrage, Serverfehler, zu viele Anfragen, unlesbare Antworten, abgelehnte Streckengeometrie oder das Zeitbudget der zusätzlichen Verbindungssuche. Mehrere Ursachen werden ohne Wiederholungen angezeigt. Bereits gefundene Routen bleiben verfügbar; nach einer fehlgeschlagenen manuellen Aktualisierung werden die bisherigen Ergebnisse wiederhergestellt. Speicherfehler und unerwartete lokale Fehler erhalten eigene Hinweise. Erfolgreich reparierte Geometrie erzeugt keinen Fehlerhinweis.

Liefert der Routingdienst bei HTTP 429 oder 503 ein zukünftiges `Retry-After` (Sekunden oder HTTP-Datum), gilt diese Pause für alle neuen `/plan`-Anfragen im laufenden App-Prozess, einschließlich Geometrie-Reparaturen und zusätzlicher Umstiegssuchen. Ein Countdown erklärt gesperrte Schaltflächen. Nach Ablauf kann man wieder selbst anfragen; die App startet dadurch keine automatische Neuberechnung. Ohne gültige Wartezeit wird kein Countdown erfunden. `/trip`-Aktualisierungen während der Navigation behalten ihre separate Wiederholungslogik. Es gibt keinen zusätzlichen allgemeinen Anfragenbegrenzer und keinen neuen Cache.

## Speicherung und Kompatibilität (iOS)

SwiftData speichert Einstellungen, Orte und bis zu 20 Fahrtzusammenfassungen. Eine gestartete Route wird mit Abschnitt und Manöver für die Wiederaufnahme gespeichert; GPS-Spuren werden nicht persistiert.

Die aktuelle Ortssuche verwendet für Start und Ziel dieselbe nach `lastUsedAt` sortierte Liste. Das optionale Feld `lastUsedAsDestinationAt` wird bei Zielauswahl weiterhin gepflegt, filtert diese Anzeige aber nicht. Einträge älterer Versionen bleiben damit ohne erneute Zielauswahl sichtbar, sofern sie ein Nutzungsdatum haben. Reine Favoriten ohne Verwendung erscheinen nur in der Favoritenliste.

Bei alten Faltzeit-Einstellungen wird der größere der beiden Werte innerhalb des erlaubten Bereichs übernommen. Die bisherigen Datenbankfelder bleiben kompatibel und erhalten beim Speichern denselben Wert. Neue serialisierte Einstellungen verwenden `foldingDuration`. Bereits berechnete Fahrten und gespeicherte Navigationsabschnitte werden nicht nachträglich verschoben.

Alte Routenspeicher ohne Navigationsstatus gelten als Planung und starten nach vollständigem Schließen keine Navigation. Details zum aktuellen Verhalten stehen unter [Navigation und Wiederaufnahme](bedienung.md#navigation-und-wiederaufnahme).
