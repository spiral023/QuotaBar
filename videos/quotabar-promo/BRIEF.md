---
workflow: product-launch-video
flow: automation
storyboard: no
message: "QuotaBar shows your Claude & Codex quota and AI spend at a glance — right in the Windows tray, before you hit the limit."
destination: youtube
aspect: 1920x1080
language: en
audience: developers who use Claude Code and Codex on Windows
length: 45s
angle: problem-to-relief
narration: no
---

## Intent

A cool, music-driven promo for QuotaBar for Windows (Electron tray app in this repo).
User's words: "ein cooles Video über die App. Mit guten Animationen. Ohne Stimme.
Circa 30 bis 60 Sekunden. Motion-Engineer-Skills ausspielen, coole Musik."

Story shape chosen: "Limit panic → calm". Cold open on a red "Rate limit reached"
moment, cut to QuotaBar in the Windows tray, then feature beats rebuilt as animated UI
(live quota bars, cost / ROI analytics, models, smart alerts, permanent history),
ending on the logo lockup and the tagline "Know your AI spend. At a glance."

## Customizations

- No voice-over. On-screen kinetic typography carries the message (English, like the app).
- Music bed from the HeyGen catalog: driving electronic / synthwave, cuts on its grid.
- UI is rebuilt in HTML from the app's own design tokens (dark canvas, neon green accent,
  Claude orange, Codex indigo, Space Grotesk-like display / mono numerals), so bars,
  counters and charts can animate.

## Notes

- Do NOT use docs/screenshots/*.png directly: they show the user's e-mail address and old
  German labels. logos/gh-hero.png is clean English marketing material and may be referenced.
- Use demo numbers only (no real account data, no e-mail addresses, no tokens).
- App and video text are English; never German strings on screen.
