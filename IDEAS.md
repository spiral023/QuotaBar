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

## Grauen Text besser lesbar machen

Grauer Text ist an manchen Stellen schwer zu lesen, weil der Kontrast zu gering ist.

Idee:

- Graue Textfarben analysieren
- Zu dunkle Grautöne heller machen
- Kontrast verbessern, ohne die ruhige Optik der App zu verlieren
