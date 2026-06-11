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

## Default-Benachrichtigungen für neue Nutzer anpassen

Für neue Nutzer der QuotaBar-App sollen folgende Benachrichtigungen zusätzlich standardmäßig deaktiviert sein:

- Erschöpfung vor Reset
- Deutlich zu schnell
- Deutlich zu langsam

Weitere Default-Werte:

- Minimum Delta standardmäßig auf 20% setzen
- Reset in Kürze standardmäßig auf 10 Minuten vor Reset setzen

## Onboarding beim ersten Start

Beim ersten Start soll es eine kurze Onboarding Experience geben.

Inhalte:

- Nutzer kurz begrüßen
- Zweck der App verständlich vorstellen
- Kurze Liste der wichtigsten Funktionen anzeigen
- Erklären, was der Nutzer mit QuotaBar machen kann
- Anzeigen, welche Coding Agents automatisch erkannt wurden

## System-Tab für erkannte Agents und lokale Daten

Es soll einen Tab `System` geben.

Mögliche Inhalte:

- Anzeigen, welche Coding Agents erkannt wurden
- Anzeigen, wo die zugehörigen Dateien liegen
- Möglichkeit, den Explorer direkt im jeweiligen Ordner zu öffnen
- Datenmenge darstellen, z. B. Anzahl der Dateien nach Typ (`logs`, `credentials`, ...)
- Größe der erkannten Dateien anzeigen
- Einstellungen optional in diesen Tab verlagern

## History-Menüleiste kompakter gestalten

In `History` soll die Menüleiste mit Zeitraumwahl (`Letzte 7 Tage`, usw.), Datumswahl, Anbieterfilter und Lücken-Option neu gestaltet werden.

Ziel:

- Alle Controls in eine einzelne Zeile bringen
- Platz sparen, ohne die Bedienbarkeit zu verschlechtern
- Gute UI/UX mit klaren Gruppierungen, ausreichenden Hit Areas und lesbaren Labels
- Frontend-Design bewusst ausarbeiten, nicht nur Controls enger zusammenschieben
- Zahlen und dynamische Werte stabil darstellen, damit nichts springt

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
