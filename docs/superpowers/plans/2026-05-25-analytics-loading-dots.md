# Analytics Loading Dots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spinner + „Lädt…"-Text im Analytics-Tab durch die pulsierenden Punkte ersetzen.

**Architecture:** Einzeilige Änderung in `analytics.js` — `.spinner` und `<span>Lädt…</span>` werden durch `<div class="loading-dots">` mit drei `<span>`-Elementen ersetzt. Die CSS-Klasse `.loading-dots` existiert bereits in `index.html`.

**Tech Stack:** Vanilla JS (Renderer)

---

### Task 1: Lade-HTML in `analytics.js` ersetzen

**Files:**
- Modify: `src/renderer/tabs/analytics.js:14`

- [ ] **Schritt 1: Zeile 14 ändern**

In `src/renderer/tabs/analytics.js` Zeile 14 ersetzen:

```javascript
// vorher:
container.innerHTML = '<div class="empty"><div class="spinner"></div><span>Lädt…</span></div>';

// nachher:
container.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
```

- [ ] **Schritt 2: Build prüfen**

```
npm run build
```

Erwartetes Ergebnis: kein Fehler (nur JS-Datei, kein TypeScript-Build nötig — aber sicherstellen dass kein Syntax-Fehler eingebaut wurde).

- [ ] **Schritt 3: Tests ausführen**

```
npm test
```

Erwartetes Ergebnis: 215 Tests grün (keine Analytics-Renderer-Tests vorhanden, aber Regressionen ausschließen).

- [ ] **Schritt 4: Committen**

```bash
git add src/renderer/tabs/analytics.js
git commit -m "feat(loading): use pulsing dots in analytics loading state"
```
