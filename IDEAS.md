# Ideas

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

## History-Detailtabelle: Spaltenüberschriften beim Scrollen sichtbar halten

Wenn man im History-Tab nach unten scrollt und die Detailtabelle ansieht, sind die Spaltenüberschriften nicht mehr sichtbar. Dadurch muss man sich merken, welche Zahl zu welcher Spalte gehört.

welche lösung sollten wir machen? z.b.

- Sticky Header innerhalb der Tabelle
- Kompakte wiederholte Kopfzeile oberhalb des sichtbaren Tabellenbereichs
- Horizontales Scrollen und Sticky Header sauber kombinieren

Ziel:

- Beim Lesen tiefer Tabellenzeilen soll klar bleiben, welche Spalte welche Bedeutung hat.

## Notification-Aktionen: Öffnen und stummschalten

Desktop-Benachrichtigungen könnten zwei direkte Aktionen bekommen:

- `Öffnen`: QuotaBar öffnen
- `Stumm`: diesen Nachrichtentyp ausschalten

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
