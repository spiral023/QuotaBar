# Provider Order via Live-Tab Drag-and-Drop

## Goal

Users can reorder provider cards directly in the Live tab by dragging an entire card. The chosen order persists and is used consistently by the Live tab, tray icon, tray tooltip, and tray menu.

## Scope

- Add a persisted `providerOrder` setting.
- Reorder whole provider cards in the Live tab with a custom Pointer Events interaction.
- Apply the saved order immediately to tray surfaces.
- Preserve all existing card clicks, expandable sections, refresh behavior, and provider fetch order.
- Keep unavailable, unauthenticated, and error-state provider cards sortable.

This feature does not change provider polling order, authentication, quota calculations, or notification behavior.

## Settings Model

`Settings` gains a `providerOrder: string[]` field. The default is:

```json
["claude", "codex"]
```

Settings normalization accepts only known provider IDs, removes duplicates, and appends known providers that are missing from stored settings. This makes old settings files migrate automatically and ensures newly supported providers remain visible.

The order is presentation state. `UsageStore` may retain its current deterministic snapshot ordering.

## Live-Tab Interaction

Each rendered provider card exposes its provider ID. The whole card is the drag target.

A pointer press alone remains a normal click. Dragging starts only after approximately six pixels of pointer movement, preventing accidental reordering when users interact with existing card content. Once dragging starts:

1. The card captures the pointer and enters a raised visual state with a stronger shadow and slight scale.
2. The dragged card follows the pointer vertically.
3. Crossing the midpoint of another provider card moves that card and previews the resulting order.
4. Text selection and conflicting click behavior are suppressed only for the active drag.
5. Releasing the pointer commits the previewed order.

The renderer updates the visible order immediately, invokes the existing `settings:save` IPC channel with `providerOrder`, and stores the returned normalized order in renderer state.

No drag starts when fewer than two provider cards are visible.

## Main-Process and Tray Data Flow

After `settings:save` persists a changed `providerOrder`, the dashboard controller notifies the `TrayController`. The tray controller stores the normalized presentation order and immediately rebuilds all order-sensitive tray output:

- tray icon bar slots,
- tray tooltip provider lines,
- tray context-menu provider sections.

The tray icon state becomes order-aware instead of relying on a hard-coded `Codex`/`Claude` slot sequence. Provider snapshots remain associated with provider IDs, so changing order cannot swap usage values between providers.

At startup, the normalized saved order is passed to both renderer settings and the tray controller before their first complete render.

## Cancellation and Failure Handling

- `Escape`, `pointercancel`, lost pointer capture, or window blur cancels the interaction and restores the pre-drag order.
- If persistence fails, the renderer restores the previous card order and leaves tray state unchanged.
- A successful save updates the Live tab and tray without restarting or refreshing quota data.
- Authentication and error-state cards participate exactly like healthy cards.
- Unknown provider IDs in saved settings are ignored; missing known providers are appended.

## Accessibility and Motion

Provider cards expose their draggable state to assistive technology. The cursor changes from grab to grabbing during interaction. Visual movement uses short transforms and respects `prefers-reduced-motion` by removing nonessential transition animation.

This iteration is pointer-based as requested. Keyboard reordering controls are outside the current scope.

## Verification

Automated coverage will include:

- settings default and normalization, including duplicates, unknown IDs, and missing providers;
- order-aware icon state and rendered tray slot sequence;
- tray tooltip and context-menu provider order;
- Live renderer ordering from settings;
- drag movement threshold;
- successful drop and persisted order;
- cancellation and save-failure rollback;
- sorting of unauthenticated and error-state cards.

After implementation, run:

```powershell
npm test
npm run build
```

Because this changes the renderer, also verify it in the real Electron window according to `TESTING.md`: reorder the cards, confirm persistence after reopening, and visually confirm that the top and bottom tray bars match the Live-tab order.
