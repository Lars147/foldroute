# Bedienung

[Projektübersicht](../README.md) · [Routingdetails](routing.md)

Diese Anleitung beschreibt den **iPhone-Prototyp**. Web und iOS teilen das Planungskonzept, aber nicht alle Einstellungen und Funktionen. Die Weboberfläche und PWA sind in der [Web-Anleitung](../web/README.md#app-oberfläche-und-pwa) beschrieben.

## Ziel suchen und Route anpassen

Unter **Wohin?** ein Ziel suchen oder eines der letzten Ziele antippen. Standort erlauben; die Route wird sofort ab aktuellem Standort für jetzt berechnet. In der Vorschau **Navigation starten** wählen.

Die Startseite zeigt die Zielsuche und bis zu fünf zuletzt verwendete Orte. Start- und Zielsuche nutzen dieselbe Liste, sortiert nach der letzten Verwendung. Beide zeigen **Aktueller Standort** dauerhaft bei leerer Suche. Antippen ermittelt den Standort; fehlende Freigabe oder GPS-Daten werden als Meldung angezeigt. Startpunkt sowie Abfahrts- oder Ankunftszeit lassen sich in der Vorschau über **Route anpassen** ändern. Ohne verfügbaren Standort bietet die App **Start wählen** und **Erneut versuchen** an. Änderungen im Anpassungsdialog werden erst nach erfolgreicher Berechnung übernommen; **Abbrechen** erhält die vorherige Route.

Im Anpassungsdialog steht **Start** oben und **Ziel** darunter. Beide Felder öffnen per Antippen die Ortssuche. Mit dem **Tauschsymbol (↕)** dazwischen lässt sich die Fahrtrichtung umkehren. Die gewählte Zeit bleibt erhalten; **Route berechnen** übernimmt die Änderungen nach erfolgreicher Planung.

## Zwischenziele

**Route anpassen → Zwischenziel hinzufügen** ergänzt bis zu drei Adressen, Orte oder Haltestellen. Die Reihenfolge ist verbindlich; Pfeile verschieben Stopps, **Entfernen** löscht einen Eintrag. Beim Tauschen von Start und Ziel kehrt sich auch die Reihenfolge der Zwischenziele um. Pro Stopp sind 0–1440 Minuten Aufenthalt einstellbar, standardmäßig 0. Die gesamte Reise einschließlich der Aufenthalte muss zur Abfahrts- oder Ankunftsvorgabe passen. Eine Rundreise zurück zum Start ist möglich; direkt benachbarte Orte müssen mindestens 30 Meter auseinanderliegen.

Zwischenziele werden auf der Karte nummeriert und im Reiseablauf angezeigt. Das Radlimit gilt je Teilstrecke zwischen den ausgewählten Orten: zweimal 20 Minuten Radfahrt über ein Zwischenziel sind bei einem Limit von 30 Minuten zulässig, auch ohne Pause. Der optionale Fahrradvergleich besucht dieselben Stopps und überschreitet das Limit nur, wenn mindestens eine Radetappe zu lang ist. Die Anzahl zusätzlicher Rad-Umstiege gilt weiterhin für die gesamte Reise; ein gewähltes Zwischenziel ist selbst kein Rad-Umstieg.

In der iPhone-Navigation bleibt **Zwischenziel erreicht** aktiv, bis du **Weiterfahren** wählst. Bei früher Bestätigung wartet die Navigation bis zur geplanten Weiterfahrt. Ist ein Anschluss nicht mehr erreichbar oder nicht zuverlässig prüfbar, wird die verbleibende Reise neu berechnet. Ohne erfolgreiche Neuberechnung bleibt der Stopp aktiv. Noch offene Zwischenziele bleiben erhalten; bestätigte Stopps werden nicht erneut angefahren. Das gilt auch nach Wiederaufnahme einer gespeicherten Navigation.

## Favoriten und Ortssuche

Orte lassen sich über den **Stern** in Suchergebnissen und Ortslisten als Favoriten markieren oder wieder entfernen. Markieren startet keine Route. Startseite, Start- und Zielauswahl zeigen dieselben Favoriten alphabetisch oberhalb von **Zuletzt verwendet**. Favoriten behalten Originalnamen und Adresse und erscheinen nicht doppelt in der Liste der letzten Orte. Sie bleiben nach Neustarts und beim Aufräumen älterer Orte erhalten; **Alle lokalen Daten löschen** entfernt sie ebenfalls. Favorisieren allein zählt nicht als Nutzung. **Aktueller Standort** lässt sich nicht favorisieren.

Die Ortssuche bietet beim Tippen ab zwei Zeichen Apple-Autovervollständigung mit bis zu zwölf Adress- und Ortsvorschlägen. Vorhandene aktuelle Standortdaten dienen als regionaler Bezug, andernfalls eine voreingestellte Suchregion; ausdrücklich genannte andere Städte bleiben suchbar. Passende Favoriten erscheinen zusätzlich. Erst die Auswahl oder das Favorisieren eines unbekannten Vorschlags löst dessen genaue Koordinaten auf. Mehrdeutige Ergebnisse benötigen eine weitere Auswahl.

Der **↖-Pfeil** übernimmt den Namen plus Leerzeichen ins Suchfeld und setzt den Cursor ans Ende, etwa für eine Hausnummer. Er startet weder Suche noch Routenplanung. Erst weiteres Tippen oder die Tastaturaktion **Suchen** lädt neue Vorschläge; die Tastatur bleibt zum Bearbeiten offen. Pfeil, Stern und Ortsname sind getrennte Aktionen. Fehler lassen die Suche offen; neue Eingabe oder Schließen verwirft verspätete Antworten. Anzahl und Inhalt der Vorschläge hängen von Apple ab.

Die gemeinsame Liste zeigt bis zu fünf zuletzt verwendete Nicht-Favoriten. Start- und Zielauswahl aktualisieren beide die Verwendung eines Ortes. Gespeichert bleiben bis zu 20 Nicht-Favoriten; Favoriten werden bei dieser Begrenzung nicht entfernt. Die Auswahl speichert den Ort auch dann, wenn anschließend keine Fahrt zustande kommt.

## Routenübersicht

Die Routenübersicht hat drei Größen: Kopfzeile, normale Übersicht und große Ansicht. Ziehe den Griff nach oben oder unten; Antippen klappt ein oder stellt die zuletzt offene Größe wieder her. Ein Tipp auf die freie Karte minimiert die Übersicht. Ein Routentipp wechselt die ausgewählte Route und behält die aktuelle Größe der Übersicht bei. In der minimierten Kopfzeile startet der gelbe **Los**-Button die Navigation; die offene Übersicht bietet weiterhin das X zum Schließen. Bei großer Schrift oder wenig Bildschirmhöhe scrollt die Kopfzeile mit den Etappen; die Aktionen bleiben erreichbar.

Jeder Routenvorschlag zeigt Abfahrt am Startort und Ankunft am Ziel gleichwertig in der Kopfzeile, darunter die Gesamtdauer. Bei ausreichend Platz stehen die Zeiten nebeneinander, sonst untereinander. Uhrzeiten an anderen Kalendertagen erhalten einen Datumszusatz. In der kleinen Ansicht bleibt „Los“ rechts; bei großer Schrift oder zu geringer Breite wandert der Button unter die Zeitangaben. Lange Kopfzeilen sind scrollbar.

## Routen manuell aktualisieren

„Aktualisieren“ neben „Route anpassen“ berechnet alle Alternativen neu. Start, Ziel und Einstellungen bleiben erhalten; „Aktueller Standort“ wird neu lokalisiert und „Jetzt“ erhält einen neuen Anfragezeitpunkt. Feste zukünftige Zeiten bleiben bestehen, abgelaufene Zeiten müssen über „Route anpassen“ korrigiert werden.

Die Karte zeigt währenddessen den Ladezustand. Nach Abschluss wird die zeitlich beste Alternative passend zur Abfahrts- oder Ankunftsvorgabe ausgewählt; die normale beziehungsweise maximierte Panelgröße bleibt erhalten. Bei Fehlern behält „Erneut versuchen“ den Planungskontext. Schließen bricht laufende Abfragen ab. In der minimierten Ansicht zuerst die Übersicht aufklappen. Bei großer Bedienungshilfe-Schrift stehen Aktualisierung und Anpassung untereinander.

Nach einer fehlgeschlagenen manuellen Aktualisierung werden die bisherigen Ergebnisse wiederhergestellt. Die Behandlung von Teilfehlern und Serverpausen beschreibt die [Routingdokumentation](routing.md#fehler-und-serverpausen).

## Einstellungen ändern

Änderungen an Radtempo, Gehzeit, Faltzeiten, Verkehrsmitteln oder Rad-Umstiegen verwerfen die bisherige Routenauswahl sofort. Beim Verlassen der Einstellungen plant FoldRoute automatisch mit den letzten Werten neu. Mehrere Änderungen werden zusammengefasst; der Speicherknopf allein startet keine Suche. Start, Ziel und Zeitwahl bleiben erhalten. „Aktueller Standort“ wird aktualisiert, „Jetzt“ neu ausgewertet; abgelaufene feste Zeiten erfordern eine Anpassung. Bei Fehlern bleibt die alte Route entfernt, und „Erneut versuchen“ erhält den Planungskontext.

Sprachansagen und Haptik lösen keine neue Route aus. Ohne bisherige Planung werden nur die Einstellungen gespeichert. Eine bereits gestartete Navigation bleibt bestehen. Alte Erst- und Nachsuchergebnisse können keine verworfene Route wiederherstellen.

## Faltzeiten und Zubringer

Unter „Klapprad“ stellt „Falten / Entfalten“ dieselbe Dauer für jeden der beiden Vorgänge ein: 1–10 Minuten in 30-Sekunden-Schritten, mit genauer Anzeige der halben Minuten. Neuinstallationen beginnen mit 3 Minuten je Vorgang.

FoldRoute vergleicht Fuß–ÖPNV–Fuß, Fuß–ÖPNV–Rad, Rad–ÖPNV–Fuß und Rad–ÖPNV–Rad sowie eine direkte Radfahrt. Unter **Einstellungen → Fußwege** lässt sich die maximale Gehzeit je Zubringer auf 1–15 Minuten einstellen, standardmäßig **2 Minuten**. Sie gilt separat vor dem ersten Einstieg und nach dem letzten Ausstieg; Faltzeiten, Wartezeiten und Fußwege beim Umsteigen zählen nicht dazu. Das Klapprad bleibt dabei und wird auf Fuß-Zubringern geschoben; Falten und Entfalten werden weiterhin eingeplant.

„Maximale Radzeit je Etappe“ begrenzt Radetappen vor, nach und zwischen ÖPNV-Fahrten gemeinsam, standardmäßig auf 30 Minuten. Falten, Entfalten und Anschlusspuffer kommen hinzu. Mit „Fahrradvergleich anzeigen“ kann zusätzlich eine längere reine Radroute erscheinen. Änderungen lösen beim Verlassen der Einstellungen die vorhandene Neuberechnung aus.

## Radetappen zwischen Linien

Unter **Einstellungen → Rad-Umstiege** sind 0–3 interne Radetappen einstellbar, standardmäßig zwei. Die gemeinsame maximale Radzeit je Etappe beträgt 1–60 Minuten, standardmäßig 30 Minuten. Null deaktiviert die zusätzliche Suche. Erste und letzte Radetappe zählen nicht mit. Falten, Entfalten und drei Minuten Anschlusspuffer kommen zur Fahrzeit hinzu; vorhandene Tempo- und Verkehrsmittel-Einstellungen gelten weiterhin.

Zunächst erscheinen die normalen Alternativen. Anschließend prüft FoldRoute zusätzliche Kombinationen aus ÖPNV, Rad und erneutem ÖPNV und ergänzt die besten Ergebnisse. Eine ausdrücklich ausgewählte Route bleibt erhalten. Schließen, neue Planung oder Navigationsstart beendet die Nachsuche. Bei Fehlern bleiben bereits gefundene Optionen nutzbar.

Suchgrenzen und Auswahlregeln stehen unter [Rad-Umstiege](routing.md#rad-umstiege).

## Hinweis bei spätem Routenstart

Beginnt die ausgewählte Route mindestens 60 Minuten nach dem gewünschten Start, zeigt die Vorschau nach Ende der Suche einen Hinweis mit Zugang zu den Einstellungen. Bei „Jetzt“ wird der Anfragezeitpunkt einmal festgehalten; bei einer Ankunftssuche entfällt der Hinweis. In der minimierten Vorschau öffnet der kurze Hinweis die normale Übersicht. Auch unvollständige Suchergebnisse können den Hinweis zeigen; bessere Verbindungen werden nicht zugesichert.

## Navigation und Wiederaufnahme

Nach vollständigem Schließen wird eine nur geplante Route verworfen. Bereits gestartete Navigation wird mit dem gespeicherten Abschnitt und Manöver automatisch fortgesetzt. Beenden oder Ankunft löscht den Wiederherstellungszustand; letzte Orte, Verlauf und Einstellungen bleiben erhalten. Hintergrundwechsel verändert die laufende Sitzung nicht. Alte Routenspeicher ohne Navigationsstatus gelten als Planung.

Die aktive Navigation öffnet sofort eine um 45° geneigte Detailkarte in Fahrtrichtung. Sie folgt dem Standort und berücksichtigt die Höhe der Infokarten. Die Kameraentfernung beträgt 600 Meter beim Radfahren, 350 Meter zu Fuß und 1.500 Meter im ÖPNV; beim Falten und Warten bleibt der letzte Maßstab erhalten. Im Stand bleibt die Blickrichtung stabil. Verschieben, Drehen oder Zoomen pausiert das Mitführen; der Standortknopf **Navigation zentrieren** aktiviert es wieder. Ohne brauchbares GPS bleibt die letzte gültige Position sichtbar, beim Wiederherstellen zunächst der gespeicherte aktuelle Abschnitt. Die Routenplanung behält ihre Gesamtübersicht.

Nach bestätigtem **Navigation beenden** berechnet FoldRoute bis zu drei aktuelle Routen ab dem aktuellen Standort zum bisherigen Ziel, mit Abfahrt jetzt. Die Karte bleibt während der Berechnung sichtbar. Bei Standort- oder Netzwerkproblemen bietet das Panel einen erneuten Versuch und die Anpassung des Starts an; die beendete Navigation bleibt gestoppt. Schließen oder eine neue Zielauswahl verwirft noch ausstehende Ergebnisse. **Fahrt abschließen** nach Ankunft löst keine Neuberechnung aus.

Für den Navigationsstart gelten [Standort- und Entfernungsgrenzen](routing.md#navigationsstart-ios). Aktuelle ÖPNV-Zeiten und Störungsvorschläge sind unter [Echtzeit während der Navigation](routing.md#echtzeit-während-der-navigation-ios) beschrieben.
