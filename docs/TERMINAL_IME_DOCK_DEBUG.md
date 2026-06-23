# Terminal IME Dock Debug Notes

This file records the Codex TUI IME/keyboard jumping investigation.

## Problem

When Codex runs inside the app terminal, its TUI redraws frequently. xterm moves
its hidden helper textarea to follow the terminal cursor. On Windows, IME
candidate windows and the touch keyboard follow that helper textarea, so they
can jump between the prompt row, output rows, and the bottom/status area.

Windows Terminal behaves better: Codex may redraw visually, but the IME/keyboard
does not jump as aggressively.

## Relevant Files

- `src/components/TerminalView.tsx`
- `src/App.css`
- Reference commit: `1a2b970c33f046f083273831a8ac4c58b622688c`

The reference commit removed an older custom IME dock. The useful idea was to
use a real DOM anchor and viewport coordinates for xterm's helper textarea,
instead of guessing xterm cursor coordinates.

## Final Approach

The current implementation intentionally docks xterm's helper textarea while the
terminal is outputting, then releases it after output settles.

- `TerminalView.tsx`
  - Adds `outputDockAnchorRef`.
  - Tracks short TUI redraw bursts with `tuiSequenceWindowRef`.
  - Uses `dockHelperTextareaDuringOutput()` to read the invisible anchor's
    `getBoundingClientRect()` and store viewport coordinates in CSS variables.
  - Uses `releaseHelperTextareaDock()` to remove those CSS variables.
  - Uses `hideCursorDuringOutput()` to toggle `.is-outputting` for `160ms`.
  - Uses `terminal.onWriteParsed()` as a broad fallback for normal streamed text.
  - Registers CSI handlers for common TUI redraw/control sequences:
    - private mode `?h` / `?l`
    - params `25`, `2026`, `1047`, `1048`, `1049`
    - cursor positioning `H` / `f`
    - erase display/line `J` / `K`
  - Renders an invisible `.terminal-output-dock` element with a span anchor.

- `App.css`
  - Hides `.xterm-cursor` while `.terminal-view.is-outputting`.
  - Fixes `.xterm-helper-textarea` to `--output-dock-*` viewport coordinates
    while `.terminal-view.is-outputting`.
  - Makes the docked helper textarea invisible, including text and caret, so it
    remains an IME anchor without showing duplicate typed/composition text near
    the bottom of the terminal.
  - Hides `.composition-view` while outputting for the same reason.
  - Defines invisible `.terminal-output-dock` and
    `.terminal-output-dock-anchor`.

Temporary debug logging has been removed:

- No `appendTerminalDebugLog` in `src/services/tauriApi.ts`.
- No `append_terminal_debug_log` command in `src-tauri/src/lib.rs`.

## What Was Tried

1. Hide xterm cursor during output.

   This reduced visual cursor flicker, but it did not fully fix IME/keyboard
   movement because the helper textarea still moved.

2. Freeze helper textarea at its current position.

   This failed because the current position was often already wrong, for example
   at Codex's bottom/right status area.

3. Keep the latest "good" prompt position.

   Several variants were tried: stable anchor, height windows, cursor row/column
   rules. This became too complex and too Codex-specific.

4. Pure CSS bottom dock.

   Example:

   ```css
   .terminal-view.is-outputting .xterm .xterm-helper-textarea {
     position: absolute !important;
     left: 0 !important;
     top: calc(100% - 1.35em) !important;
   }
   ```

   This caused the Windows IME candidate bar to appear near the top of the app.
   Pure absolute positioning inside xterm did not give the OS a stable viewport
   coordinate.

5. Invisible real dock anchor with fixed helper textarea.

   This worked after two important additions:

   - Add `terminal.onWriteParsed()` so ordinary streamed text triggers the dock,
     not only CSI-heavy TUI redraws.
   - Keep the docked helper textarea visually transparent. Otherwise typed or
     composing text can appear both at the real prompt and near the dock.

## Tradeoff

This approach intentionally gives up exact IME positioning during output. While
Codex is streaming or redrawing, the helper textarea is docked near the terminal
bottom. After output settles, xterm regains control and input returns to the
actual prompt position.

This is simpler and more robust than maintaining Codex-specific cursor rules.

## Validation Checklist

Manual checks:

- Run `codex` inside the app terminal.
- Let Codex stream normal text.
- While it streams, type Chinese and open the IME candidate bar.
- Confirm the keyboard/candidate bar stays stable and does not jump to upper
  output rows.
- Confirm the bottom dock does not show duplicate typed/composition text.
- After output stops, confirm normal typing continues at the Codex prompt.
- Switch tabs and resize the terminal; confirm the helper textarea is not stuck
  at the dock.

## Last Known Verification

- `npm run build` passed.
- `cargo check` passed.
- Manual testing confirmed the keyboard/candidate bar was stable after
  `onWriteParsed()` was added and the docked helper textarea was made invisible.
