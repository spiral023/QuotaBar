# Ideas

## 5h-Fenster im Weekly-Limit darstellen

Ich will sehen, wie viele 5h-Fenster bei 100% Auslastung in ein Weekly-Fenster passen.

Beispiel: Wenn 12x ein 5h-Fenster zu 100% genutzt wurde, entspricht das 100% des Weekly-Limits.

Mögliche Darstellung:

- Kennzahl: Anzahl verbleibender 5h-Fenster bis zum Weekly-Limit
- Kennzahl: Verbrauchte 5h-Fenster im aktuellen Weekly-Fenster
- Graph im Zeitverlauf, der zeigt, wie sich die 5h-Auslastungen zum Weekly-Limit aufsummieren
- Optional: Prognose, wann das Weekly-Limit erreicht wird, wenn die aktuelle Nutzung so weitergeht

## Schlankes Docker-Addon für Limits, Resets und Home Assistant

Ein schlankes Addon erstellen, das in einem Docker-Container läuft und regelmäßig Daten zu vorhandenen Nutzungslimits und Resets abfragt, z. B. alle 5 Minuten.

Mögliche Funktionen:

- Nutzungslimits und Reset-Zeitpunkte abrufen
- Prozentuale Nutzung an Home Assistant übertragen, z. B. per MQTT
- `% Used` langfristig in Home Assistant speichern und als Chart darstellen
- Benachrichtigungen versenden, wenn ein Nutzungslimit zurückgesetzt wurde
- E-Mail-Versand optional über Resend

## Extremwerte in Tabellen dezent hervorheben

In Tabellen könnten Extremwerte visuell hervorgehoben werden, z. B. sehr hohe API-Kosten einer Woche rot und besonders günstige Tage grün.

Wichtig:

- Farbgebung dezent halten, damit die Tabellen nicht zu bunt wirken
- Nur aussagekräftige Ausreißer markieren
- Hervorhebung soll das Scannen erleichtern, nicht vom eigentlichen Wert ablenken

## Legende für Modell-Verteilung im Models-Tab

Bei der Modell-Verteilung im Models-Tab soll unterhalb des Diagramms eine Legende angezeigt werden, damit sofort klar ist, welche Balkenfarbe zu welchem Modell gehört.

Idee:

- Direkt unter dem Diagramm alle sichtbaren Modelle nebeneinander anzeigen
- Je Modell ein kleines Farbfeld plus Modellname
- Reihenfolge der Legende entspricht der Reihenfolge/Staplung im Diagramm
- Bei vielen Modellen umbrechen oder horizontal scrollen, damit die Diagrammfläche nicht verdrängt wird
- Optional: Klick auf einen Legendeneintrag blendet das Modell im Diagramm ein/aus oder hebt es hervor

Wichtig:

- Farben müssen exakt aus derselben Palette/Zuordnung kommen wie die Balkensegmente.

## Models: Kosten-Tooltip in Modell-Verteilung korrekt runden

In der Modell-Verteilung im Models-Tab werden beim Mouseover teilweise Kostenwerte mit sehr vielen Nachkommastellen angezeigt, wenn als Metrik `Kosten` ausgewählt ist.

Problem:

- Tooltip zeigt teils Werte mit ca. 10 Nachkommastellen.
- Erwartet sind Kostenwerte mit zwei Nachkommastellen, z. B. `$1.23`.
- Das betrifft die Balken/Segmente der 100%-Stacked-Modellverteilung.

## History-Detailtabelle: Spaltenüberschriften beim Scrollen sichtbar halten

Wenn man im History-Tab nach unten scrollt und die Detailtabelle ansieht, sind die Spaltenüberschriften nicht mehr sichtbar. Dadurch muss man sich merken, welche Zahl zu welcher Spalte gehört.

Später brainstormen:

- Sticky Header innerhalb der Tabelle
- Kompakte wiederholte Kopfzeile oberhalb des sichtbaren Tabellenbereichs
- Horizontales Scrollen und Sticky Header sauber kombinieren
- Mobile/kleine Fenster berücksichtigen, damit nichts überlappt

Ziel:

- Beim Lesen tiefer Tabellenzeilen soll klar bleiben, welche Spalte welche Bedeutung hat.
- Die Lösung soll zur ruhigen, kompakten History-Ansicht passen.

## Scrollbalken besser sichtbar machen

Die Scrollbalken sind aktuell sehr dezent und in manchen Bereichen kaum erkennbar, z. B. im History-Tab. Dadurch sieht man nicht sofort, dass ein Bereich scrollbar ist oder wo man sich im Inhalt befindet.

Idee:

- Scrollbar-Thumb mit etwas stärkerem Kontrast gestalten
- Farbe heller oder leicht akzentuiert wählen, ohne die ruhige Optik zu stören
- Hover-Zustand sichtbarer machen
- Prüfen, ob alle scrollbaren Bereiche konsistent gestylt sind: History, Models, Notifications, Settings, System

Ziel:

- Scrollbare Inhalte sollen sofort erkennbar sein.
- Die Position im Scrollbereich soll besser ablesbar sein.

## Schmale Refresh-Leiste am unteren Rand

Am unteren Rand des Fensters könnte eine sehr schmale farbige Leiste anzeigen, wie lange es noch bis zur nächsten Datenaktualisierung durch QuotaBar dauert.

Idee:

- Dünne Progress-Leiste direkt am unteren Fensterrand
- Leiste läuft animiert von voll nach leer oder von links nach rechts bis zum nächsten Refresh
- Nach erfolgreicher Aktualisierung startet die Animation neu
- Bei laufender Aktualisierung kurzer Pulse- oder Ladezustand
- Bei Fehlern oder veralteten Daten optional Farbe ändern, z. B. gelb/rot

Ziel:

- Man sieht sofort, ob QuotaBar gerade aktuelle Daten hat oder wann der nächste Poll kommt.
- Die Anzeige bleibt subtil und nimmt keinen Platz im eigentlichen Inhalt weg.

## Notification-Aktionen: Öffnen und stummschalten

Desktop-Benachrichtigungen könnten zwei direkte Aktionen bekommen:

- `Öffnen`: QuotaBar-Dashboard öffnen und zum passenden Bereich springen
- `Stumm`: diesen Nachrichtentyp deaktivieren oder stummschalten

Alternativ als etwas explizitere Labels:

- `QuotaBar öffnen`
- `Typ deaktivieren`

Idee:

- Jede Notification trägt intern ihre Rule-ID mit, z. B. `highUsage` oder `resetSoon`.
- Klick auf `Öffnen` bringt das bestehende Fenster nach vorne und öffnet den Notifications-Tab oder den relevanten Provider.
- Klick auf `Stumm` setzt `notifications.rules[ruleId].enabled = false` und speichert die Settings.
- Optional statt dauerhaft deaktivieren: `Für heute stummschalten`, damit eine versehentliche Aktion nicht zu viel abschaltet.
- Aktion im Notification-Verlauf sichtbar machen, z. B. "Typ deaktiviert".

Wichtig:

- Electron/Windows-Unterstützung für Notification-Actions prüfen; falls Buttons nicht zuverlässig erscheinen, als Fallback Klick auf die Notification zum Öffnen nutzen und den `Stumm`-Befehl im Notification-Verlauf anbieten.
- Keine sensitiven Inhalte in Action-Payloads oder Logs speichern.

## Grauen Text besser lesbar machen

Grauer Text ist an manchen Stellen schwer zu lesen, weil der Kontrast zu gering ist.

Idee:

- Graue Textfarben analysieren
- Zu dunkle Grautöne heller machen
- Kontrast verbessern, ohne die ruhige Optik der App zu verlieren
