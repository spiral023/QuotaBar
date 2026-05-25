# Analytics Lade-Indikator: Pulsing Dots

**Datum:** 2026-05-25
**Status:** Genehmigt

## Änderung

In `src/renderer/tabs/analytics.js` Zeile 14 den bestehenden Spinner + Text durch die pulsierenden Punkte ersetzen:

```javascript
// vorher:
container.innerHTML = '<div class="empty"><div class="spinner"></div><span>Lädt…</span></div>';

// nachher:
container.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
```

Die CSS-Klasse `.loading-dots` wurde bereits in `src/renderer/index.html` (Feature: loading-indicator, 2026-05-25) definiert. Kein weiterer CSS-Aufwand.
