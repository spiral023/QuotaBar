---
format: 1920x1080
duration: 47.2s
message: "QuotaBar shows your Claude & Codex quota and AI spend at a glance — right in the Windows tray, before you hit the limit."
arc: PAS with feature-benefit progression (hook → pain → product intro → promise → live → cost → models → alerts → trust → CTA)
audience: developers who use Claude Code and Codex on Windows
mode: autonomous
music: driving dark synthwave electronic, punchy modern tech launch, steady four-on-the-floor around 120 bpm, energetic build, no vocals
narration: none — on-screen kinetic typography only (no SCRIPT.md)
---

# QuotaBar — "Limit panic → calm" promo

This video tells developers who live in Claude Code and Codex that QuotaBar shows their quota
and AI spend at a glance, right in the Windows tray — before they hit the limit.

No voice-over. Every frame's copy is on-screen text (`onscreen:`); reveals are paced to the music
grid, not to narration.

## Video direction

**Music grid (load-bearing).** `assets/bgm/track.mp3` is a 161 bpm synthwave bed: **1 beat = 0.3726 s,
1 bar (4 beats) = 1.490 s.** The first 7.0 s are a tense arpeggio intro; the **kick drop lands at
exactly 7.00 s** = the first frame of Frame 3. Every frame duration is a whole number of beats, so
frame starts sit on the downbeat. Inside a frame, place every reveal on a beat offset
(0, 0.373, 0.745, 1.118, 1.490, 1.863, 2.236, 2.608, 2.981, 3.353, 3.726, 4.099, 4.471, 4.844,
5.216, 5.589 s …). "Beat N" in the Scene lines = N × 0.3726 s after the frame starts.
"Reveal on the beat" replaces "reveal on the VO cue" — same anti-PowerPoint discipline.

**Palette system (from `frame.md`).** Ground `ink-black #07090d` everywhere (dark register) with a
faint 1px hairline grid at ~4% white for depth. `fire-orange` in frame.md is QuotaBar's **neon green
#52d017** — the one frame accent (kickers, accent clause, glow, rule stub). Text `cream #e6eff6`,
muted `#8298aa`. **Product UI exemption:** the rebuilt QuotaBar UI uses the app's own tokens —
surface `#0b0e14`, cards `#0f1319` with 1px `rgba(255,255,255,0.07)` border and 11px radius,
Claude `#DA785B`, Codex `#4B55C8`, alarm `#ff4444` (Frame 1 alarm + Frame 8 90% toast only),
yellow `#ffd700` only for the playhead marker on bars. One green-register frame: Frame 4 (ink on green).

**Type (from `frame.md` roles).** Display = Syne 800 lowercase, negative-tracked. Body/lead = DM Sans.
Chrome, kickers, numerals, terminal text = IBM Plex Mono (uppercase + 0.14em for kickers;
`tabular-nums` for all counting numbers). The logo wordmark is the app's style: Syne 700,
UPPERCASE, 0.18em tracking. Feature frames carry a mono kicker `0N / FEATURE` + a lowercase
Syne headline (h2) on the left third, the rebuilt UI on the right two-thirds (asymmetric 40/60).

**Motion grammar.** Long-tail `power3.out` / `expo.out` settles; no bounce, no back/elastic.
Kinetic type uses hard-cut swaps and beat-slams on the grid. UI pieces reveal sequentially on beats
(bars fill, numbers count, rows cascade). Entrances use `fromTo`. No infinite loops, no randomness —
glitch offsets come from a fixed table. Holds: subtle low-amplitude jitter at most; no breathing,
no back-half drifting camera. A gentle one-time push-in on the UI hero during its first 1.5 s is
allowed (camera settles, then holds).

**Rhythm / held frames.** Frames 1–2 = tension (sparse, jittery, red). Frame 3 = release on the drop.
**Frame 4 is the breather/statement** (green register, near-still after the slam). Frames 5–8 =
feature run, consecutive push-slide LEFT, dense and kinetic. Frame 9 = calm cascade, holds.
Frame 10 = lockup, the final 2 s held still, then fade to black with the music.

**Negative list.** No screenshots from docs/screenshots (personal e-mail + German labels) — UI is
rebuilt in HTML. No e-mail addresses, no real tokens, no German words. No purple/blue "AI" gradients,
no bokeh, no stock icons standing in for the product. No slideshow (front-load then freeze), no
screensaver (many elements floating independently). Content stays in the top ~83% (no captions,
but keep the bottom band calm), except the Windows taskbar in Frames 3 and 8, which is a
deliberate product reconstruction anchored to the bottom edge.

## Frame 1 — Limit hit

- scene: A dark terminal; a Claude Code session is streaming code, then a red "Usage limit reached" alarm slams in and the screen glitches.
- voiceover: ""
- onscreen: "> refactor the auth module…" (typed) → "⚠ Usage limit reached · resets in 3h 12m" (red alarm) → kinetic word "again?"
- duration: 4.02s
- transition_in: cut
- status: animated
- src: compositions/frames/01-limit-hit.html
- type: hook
- persuasion: Pain validation
- beat: frustration + tension
- blueprint: typewriter-reveal (Adapt)
- asset_candidates: assets/claude-logo.png — Claude provider mark for the terminal session header
- focal: terminal window (registry component `code-terminal-run`, customized to the Claude Code look) + registry component `rgb-glitch-text` for the alarm line glitch
- roles: claude-logo = supporting (tiny, in the terminal title bar)
- sfx: keyboard typing, error glitch impact

Adapt: keep the live type-on with caret (signature); instead of collapsing into the brand, the line is cut off by a red alarm and the text glitches — the brand is deliberately withheld until Frame 3.
Scene 1 (0.00–1.86s): Centered terminal window (~62% width, dark `#0b0e14`, 11px radius, mono, title bar "claude — ~/projects/api" with the tiny Claude mark). Prompt line `> refactor the auth module and add tests` TYPES on with a blinking green caret (`discrete-text-sequence` + `context-sensitive-cursor`), then 3 short streamed output lines appear one per beat ("● Reading src/auth/session.ts", "● Editing 4 files…", "● Writing tests…") in muted mono. A one-time slow push-in on the terminal (`multi-phase-camera`) settles by 1.5 s.
Scene 2 (1.86–2.98s, beat 5): HARD hit on the beat — the stream freezes; a red alarm bar slams in across the terminal: "⚠ Usage limit reached · resets in 3h 12m" in alarm red `#ff4444`, the whole terminal shakes and RGB-splits for 3 frames from a fixed offset table (deterministic glitch), red vignette pulses once at the frame edges.
Scene 3 (2.98–4.02s, beat 8): Terminal dims to ~35% and blurs slightly (`depth-of-field-blur`); a huge lowercase Syne word "again?" beat-slams in over it, cream with the "?" in red (`kinetic-beat-slam`), and holds with a tiny jitter.

narrativeRole: the everyday pain every Claude Code / Codex user knows — the session dies mid-flow.
keyMessage: you hit the limit with zero warning.

## Frame 2 — No warning

- scene: Pain statements land alone on the black canvas, one per beat.
- voiceover: ""
- onscreen: "no warning." → "no idea how close you were." → "no idea what it cost."
- duration: 2.98s
- transition_in: zoom-through 0.3s
- status: animated
- src: compositions/frames/02-no-warning.html
- type: pain_point
- persuasion: Pain agitation (rule of three)
- beat: anxiety → frustration
- blueprint: kinetic-type-beats (Reproduce)
- asset_candidates:
- sfx: bass hit

Reproduce: 3 short pain statements, each landing solo on a bare canvas by hard cut.
Scene 1 (0.00–0.75s): Black ground + faint hairline grid. "no warning." — Syne 800 lowercase, display size, left-anchored at the left third, slams in (scale 1.15→1, blur→0, `kinetic-beat-slam`).
Scene 2 (0.75–1.86s, beat 2): HARD CUT word-swap (`discrete-text-sequence`) to "no idea how close you were." (h1 size, two lines). The word "close" underlines with a thin red stroke growing left→right (a simple scaleX line).
Scene 3 (1.86–2.98s, beat 5): HARD CUT to "no idea what it cost." — the word "cost" turns red on the next beat (a single hard color swap), then holds. Mono kicker "CLAUDE CODE · CODEX" sits top-left in muted mono the whole frame.

narrativeRole: agitate — the real problem is not the limit, it is being blind to it.
keyMessage: you're flying blind on quota and cost.

## Frame 3 — Meet QuotaBar in the tray

- scene: The Windows taskbar rises; the QuotaBar diamond pops into the tray, then the tray popup springs open with Claude and Codex bars filling to 68% and 1%.
- voiceover: ""
- onscreen: kicker "Introducing" → "QuotaBar" wordmark; tray popup: CLAUDE 68% · 5-HOUR · 03:04:46 / CODEX 1% · 5-HOUR · 04:58:04
- duration: 5.96s
- transition_in: blur-crossfade 0.25s
- status: animated
- src: compositions/frames/03-tray-intro.html
- type: product_intro
- persuasion: Show-don't-tell proof
- beat: curiosity → relief
- blueprint: device-surface-showcase (Adapt)
- asset_candidates: assets/quotabar-mark.svg — green diamond logo mark (tray icon + wordmark); assets/claude-logo.png — Claude mark for the popup row; assets/codex-logo.png — Codex mark for the popup row
- focal: assets/quotabar-mark.svg
- roles: quotabar-mark = cutout (tray icon, then lockup) · claude-logo = supporting · codex-logo = supporting
- sfx: deep impact on the drop, soft pop, whoosh

Adapt: the "surface" is the Windows tray itself; it is established, operated (icon click → popup opens) and advances once (bars fill). Keep the surface-as-hero signature; no cursor needed — the popup opens on the beat.
Scene 1 (0.00–1.49s, the DROP): On the downbeat, a neon-green shockwave ring expands from the bottom-right corner (a single expanding ring, scale + fade), and a dark Windows 11 taskbar slides up from the bottom edge (full width, 48px-tall look scaled for 1080p, centered app icons as simple glyph blocks, clock "10:48" right). On beat 2 the QuotaBar diamond mark POPS into the tray area right of the chevron (scale 0→1, smooth power3 settle, no overshoot) with a green glow halo.
Scene 2 (1.49–3.35s, beat 4): The tray popup scales up from the icon (transform-origin bottom-right, uniform scale 0.6→1 + fade, power3): a QuotaBar card (~640px wide on canvas, app tokens) with two provider rows — Claude mark + "CLAUDE" + "5-HOUR" + mono countdown "03:04:46", Codex mark + "CODEX" + "5-HOUR" + "04:58:04". On beat 6 the Claude bar FILLS 0→68% in Claude orange while its percentage counts 0→68% (`stat-bars-and-fills` + `counting-dynamic-scale`); on beat 7 the Codex bar fills to 1% in indigo with "1%" in green. The countdowns tick down second by second (deterministic, from the timeline).
Scene 3 (3.35–5.96s, beat 9): Left side of the frame, a mono kicker "INTRODUCING" (green) appears, then on beat 11 the wordmark "QUOTABAR" (Syne 700, uppercase, 0.18em) reveals letter-by-letter with a green diamond mark left of it (`dynamic-content-sequencing`); on beat 13 a lead line in DM Sans muted: "Claude & Codex limits — live in your Windows tray." Hold; subtle jitter only. Layout: asymmetric — wordmark left third, popup + taskbar bottom-right.

narrativeRole: the answer appears exactly where a Windows user already looks — the tray.
keyMessage: QuotaBar lives in your Windows tray.

## Frame 4 — The promise

- scene: Massive lowercase statement, ink on the neon-green register, one clause landing on the beat.
- voiceover: ""
- onscreen: "know your ai spend." → "at a glance."
- duration: 2.98s
- transition_in: zoom-through 0.3s
- status: animated
- src: compositions/frames/04-promise.html
- type: benefit_highlight
- persuasion: Promise / value claim
- beat: clarity + confidence
- blueprint: kinetic-type-beats (Reproduce)
- asset_candidates:
- sfx: bass hit

Reproduce: a statement built across two beats onto a payoff; this is the video's only green-register frame (the breather).
Scene 1 (0.00–1.12s): Full-bleed neon green `#52d017` ground. "know your ai spend." in ink-black Syne 800 lowercase, h1/display size, left-aligned in the upper half — words land one per beat (`dynamic-content-sequencing`, smooth power3 rise from 30px below + blur→0).
Scene 2 (1.12–2.98s, beat 3): "at a glance." beat-slams in beneath (`kinetic-beat-slam`), same size, ink; a thin ink rule stub (36×2 scaled) draws under it; then the frame HOLDS still — the stillness is the point. Mono catalogue mark "QUOTABAR / 01" small at top-left in 55% ink.

narrativeRole: lands the value claim (the brand tagline) right after the product appears.
keyMessage: know your AI spend — at a glance.

## Frame 5 — Live quota

- scene: The rebuilt QuotaBar Live card floats as hero: 5-hour bar fills, countdown ticks, weekly segmented bar steps, "On Track" badge pops, forecast line types.
- voiceover: ""
- onscreen: kicker "01 / Live quota" · headline "see the limit coming." · UI: CLAUDE 68% · 5-HOUR 03:04:46 · +45 %/h · WEEKLY 15:14:47 · "On Track" · "At current pace: lasts until reset"
- duration: 5.96s
- transition_in: push-slide LEFT 0.35s
- status: animated
- src: compositions/frames/05-live-quota.html
- type: feature_showcase
- persuasion: Feature-to-benefit translation
- beat: control
- blueprint: device-surface-showcase (Adapt)
- asset_candidates: assets/claude-logo.png — Claude mark on the provider card; assets/quotabar-mark.svg — title-bar logo of the app window
- focal: rebuilt QuotaBar window (Live tab)
- roles: claude-logo = supporting (card icon) · quotabar-mark = supporting (title bar)
- sfx: ui tick, soft whoosh

Adapt: floating-window variant — the QuotaBar window (title bar with diamond + "QUOTABAR", tab row LIVE active with green underline, ANALYTICS, MODELS, ALERTS, HISTORY, PLANS, SYSTEM) is the hero, slightly tilted in 3D (rotateY −8°, settles to −4°), and its card content advances piece by piece. Keep the signature: surface held as hero while its content advances.
Scene 1 (0.00–1.49s): Left 40%: mono kicker "01 / LIVE QUOTA" (green) then lowercase Syne h2 "see the limit coming." reveals word-by-word. Right 60%: the window slides in from the right and settles (power3), Claude provider card visible: icon, "CLAUDE", "68%" in green top-right, label "5-HOUR" + countdown "03:04:46".
Scene 2 (1.49–2.98s, beat 4): The 5-HOUR bar fills 0→68% in green with a yellow playhead tick at ~38% (pace marker) (`stat-bars-and-fills`); the countdown ticks; "+45.0 %/h" fades up beneath in mono on beat 6.
Scene 3 (2.98–4.47s, beat 8): "WEEKLY" row: the red-to-orange weekly bar fills to 92% and a row of 14 small segment blocks below it lights up one per half-beat in the app's window-segment blue `#4a9ee0` (spent segments dimmer `#2a4a66`) — staggered left→right (`grid-card-assemble` stagger logic / `stat-bars-and-fills`). Countdown "15:14:47".
Scene 4 (4.47–5.96s, beat 12): A green pill badge "On Track" pops (smooth settle, `spring-pop-entrance`), then the forecast line types in DM Sans: "At current pace: lasts until reset" (`discrete-text-sequence`); a soft green glow blooms behind the badge. Hold with subtle jitter.

narrativeRole: first proof — 5-hour and weekly windows with countdown and pace forecast.
keyMessage: you see the limit coming before it hits.

## Frame 6 — What it's really worth

- scene: Quick-stat tiles count up, then the cost-per-day chart draws itself in Claude orange and Codex indigo.
- voiceover: ""
- onscreen: kicker "02 / Cost analytics" · headline "know what it's worth." · tiles: API EQ. (30D) $594 · SUB ROI 21.2× · CACHE HIT 97.3% · chart "API cost per day (30 days)"
- duration: 5.96s
- transition_in: push-slide LEFT 0.35s
- status: animated
- src: compositions/frames/06-cost-analytics.html
- type: feature_showcase
- persuasion: Statistical proof
- beat: power + aspiration
- blueprint: dataviz-countup (Adapt)
- asset_candidates:
- focal: SUB ROI 21.2× tile
- sfx: counter ticks, impact on the ROI number

Adapt: Key_Feature montage mode without hard cuts — three stat tiles count up in sequence, then a trend chart draws; the hero metric (ROI) gets the glow. Keep the count-up-with-scale signature.
Scene 1 (0.00–1.49s): Left 40%: kicker "02 / COST ANALYTICS" + h2 "know what it's worth." word-by-word. Right 60%: a 2-up tile row establishes (cards `#0f1319`). Tile 1 "API EQ. (30D)" counts $0→$594 in cream mono with scale growth (`counting-dynamic-scale`).
Scene 2 (1.49–2.98s, beat 4): Tile 2 "SUB ROI" counts 0.0×→21.2× in neon green, larger than tile 1 — on landing, a green glow blooms behind it (a soft radial green glow fading up once) — this is the hero metric. Beat 6: a small third chip "CACHE HIT 97.3%" pops beside it.
Scene 3 (2.98–5.96s, beat 8): Beneath the tiles, a chart card "API COST PER DAY (30 DAYS)": a Claude-orange area line DRAWS left→right across 30 points with dot markers (`svg-path-draw`), and on beat 11 a Codex-indigo line draws under it; a dashed vertical annotation "Pro → Max 5×" fades in at ~40% x. Legend dots "Claude" / "Codex". Hold.

narrativeRole: second proof — API-equivalent cost and subscription ROI turn usage into value.
keyMessage: your subscription is worth 21× in API terms.

## Frame 7 — Every model, ranked

- scene: Top-models table rows cascade in with cost share bars growing; donut ring closes around the split.
- voiceover: ""
- onscreen: kicker "03 / Models" · headline "every model, ranked." · rows: opus-4-8 $231.39 39% · gpt-5.5 $104.05 18% · sonnet-4-6 $101.27 17% · haiku-4-5 $5.70 1%
- duration: 4.47s
- transition_in: push-slide LEFT 0.35s
- status: animated
- src: compositions/frames/07-models.html
- type: feature_showcase
- persuasion: Value stacking
- beat: clarity
- blueprint: grid-card-assemble (Adapt)
- asset_candidates:
- focal: top-models table
- sfx: soft ticks per row

Adapt: a self-populating data board — table rows assemble in a staggered cascade, each row's share bar growing; plus a donut ring that sweeps closed. Keep the staggered-cascade signature.
Scene 1 (0.00–1.12s): Left 40%: kicker "03 / MODELS" + h2 "every model, ranked." Right 60%: card "TOP MODELS BY COST (30 DAYS)" with header row MODEL · COST · % in mono muted.
Scene 2 (1.12–3.35s, beats 3–9): Four rows cascade in one per 1.5 beats (slide up 16px + fade, power3): opus-4-8 $231.39 39% (Claude orange bar), gpt-5.5 $104.05 18% (Codex indigo bar), sonnet-4-6 $101.27 17% (orange), haiku-4-5 $5.70 1% (orange). Each row's thin share bar grows to its % as the row lands; the cost counts up (`stat-bars-and-fills`, `counting-dynamic-scale`).
Scene 3 (3.35–4.47s, beat 9): A donut (orange 77% / indigo 23%) sweeps closed at the card's right edge (`svg-path-draw` ring) with "77% · 23%" legend; hold.

narrativeRole: third proof — per-model breakdown across Claude and Codex.
keyMessage: see which model eats your budget.

## Frame 8 — Smart alerts

- scene: A Windows notification toast slides in from the bottom-right ("5-hour window at 90%"), then a second toast stacks ("Weekly window reset — 0% used"); the bar empties back to green.
- voiceover: ""
- onscreen: kicker "04 / Smart alerts" · headline "never get surprised again." · toast 1 "QuotaBar · Claude 5-hour window at 90% — resets in 41 min" · toast 2 "QuotaBar · Claude weekly window reset — 0% used"
- duration: 4.47s
- transition_in: push-slide LEFT 0.35s
- status: animated
- src: compositions/frames/08-alerts.html
- type: feature_showcase
- persuasion: Risk reversal
- beat: peace of mind
- blueprint: compose
- asset_candidates: assets/quotabar-mark.svg — app icon inside the toast
- focal: Windows toast notifications (registry component `notification-stack`, restyled as Windows 11 toasts)
- roles: quotabar-mark = supporting (toast app icon)
- sfx: notification chime ×2

Compose: cursor-ui-demo did not fit (no clicks needed) — composed from slide-in + stacked toasts + bar state flip.
Scene 1 (0.00–1.12s): Left 40%: kicker "04 / SMART ALERTS" + h2 "never get surprised again." Right: a dimmed desktop area with the taskbar along the bottom edge (same as Frame 3, tray diamond visible) — continuity with Frame 3.
Scene 2 (1.12–2.61s, beat 3): Toast 1 slides in from the right edge above the tray (Windows 11 style: dark acrylic card `#1b1f27`, 8px radius, app line "◆ QuotaBar" with the mark, title "Claude · 5-hour window at 90%", body "Resets in 41 min · slow down or switch model", a thin progress bar at 90% in alarm red). Smooth power3 slide, not bouncy. The tray icon pulses once (single finite glow).
Scene 3 (2.61–4.47s, beat 7): Toast 2 slides in and pushes toast 1 up (stacking): title "Claude · weekly window reset", body "Fresh window — 0% used", its bar sweeps from 90% back down to 0% and turns green; a green check draws in (`svg-path-draw`). Hold.

narrativeRole: closes the loop on the hook — the warning you never got, now arrives on time.
keyMessage: QuotaBar warns you before the limit and tells you when it resets.

## Frame 9 — Built to trust

- scene: Four value cards self-assemble in a staggered cascade, each with a small line icon, then hold.
- voiceover: ""
- onscreen: "privacy-first — reads only known local paths" · "permanent history — survives log cleanup" · "offline-first — your data stays yours" · "open source — free, MIT"
- duration: 4.47s
- transition_in: crossfade 0.3s
- status: animated
- src: compositions/frames/09-trust.html
- type: benefit_highlight
- persuasion: Risk reversal + authority (open source)
- beat: trust
- blueprint: grid-card-assemble (Reproduce)
- asset_candidates:
- sfx: soft pops

Reproduce: N=4 cards self-assemble in a staggered cascade into a 4-across row and hold.
Scene 1 (0.00–0.75s): Kicker "BUILT FOR DEVELOPERS" (green mono) + lowercase Syne h2 "yours. local. open." top-left.
Scene 2 (0.75–3.35s, beats 2–9): Four top-border-only cards (frame.md stat-card style: 1px top hairline, green accent stub) assemble one per 2 beats from below (power3): each = a simple green line icon drawn on (`svg-path-draw`: lock, database stack, shield-check, code brackets) + Syne h3 lowercase title ("privacy-first", "permanent history", "offline-first", "open source") + DM Sans muted line ("reads only known local CLI paths", "survives provider log cleanup", "works locally — your data stays yours", "free · MIT · Electron + TypeScript").
Scene 3 (3.35–4.47s, beat 9): All four held; a single green highlight sweep passes along the top hairlines left→right once. Hold.

narrativeRole: removes the last objection for developers — it's local, private and open.
keyMessage: local, private, permanent, open source.

## Frame 10 — Lockup

- scene: The diamond mark assembles from its three layers, QUOTABAR wordmark tracks in, tagline and URL land and hold, then fade to black.
- voiceover: ""
- onscreen: "QUOTABAR" · "Know your AI spend. At a glance." · "Free for Windows · github.com/spiral023/QuotaBar"
- duration: 5.96s
- transition_in: crossfade 0.3s
- status: animated
- src: compositions/frames/10-lockup.html
- type: cta
- persuasion: Friction reduction (free, one download)
- beat: motivation + inevitability
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/quotabar-mark.svg — diamond mark, built from its three layers
- focal: assets/quotabar-mark.svg
- roles: quotabar-mark = cutout (center, rebuilt as 3 inline SVG paths so each layer can animate)
- sfx: riser into impact, shimmer

Adapt: parts-assembly — the mark is built from its own three diamond layers, then the wordmark completes the lockup and the CTA line wipes in. Keep the "mark comes to exist from its parts" signature; no push-through.
Scene 1 (0.00–1.49s): Black ground, faint grid. The outer green diamond DRAWS its outline (`svg-path-draw`) and fills; on beat 2 the dark inner diamond scales in from 0 (cuts the hole); on beat 3 the small green core pops in — a green glow blooms behind the mark (a soft radial green glow fading up once). Mark centered, large (~22% frame height).
Scene 2 (1.49–2.98s, beat 4): The mark slides left as "QUOTABAR" (Syne 700, uppercase, 0.18em, cream) reveals letter-by-letter to its right (mask unmask, `dynamic-content-sequencing`), forming a centered horizontal lockup.
Scene 3 (2.98–4.47s, beat 8): Beneath, the tagline "Know your AI spend. " (muted) + "At a glance." (green) wipes in left→right with a green leading edge (`techniques.md` clip-path reveal); on beat 10 the CTA pill "Free for Windows" (green outline) + mono URL "github.com/spiral023/QuotaBar" fade up.
Scene 4 (4.47–5.96s): Hold completely still; from 5.2s fade the whole frame to black (final frame's real exit), matching the music fade-out.

narrativeRole: the brand lands and the viewer knows where to get it.
keyMessage: QuotaBar — free for Windows.
