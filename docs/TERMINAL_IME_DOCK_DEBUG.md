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

The current implementation intentionally docks xterm's helper textarea all the
time for active terminal views. This gives Windows IME and the touch keyboard one
stable viewport anchor instead of letting them follow xterm's cursor through
Codex redraws.

- `TerminalView.tsx`
  - Adds `outputDockAnchorRef`.
  - Uses `dockHelperTextarea()` to read the invisible anchor's
    `getBoundingClientRect()` and store viewport coordinates in CSS variables.
  - Refreshes the dock coordinates on mount, fit/resize, and active-terminal
    focus.
  - Keeps `.is-ime-docked` on the terminal view so the fixed helper textarea CSS
    applies continuously.
  - Uses `terminal.onWriteParsed()` and common CSI redraw/control handlers to
    toggle `.is-outputting` briefly while terminal output is being parsed.
  - Renders an invisible `.terminal-output-dock` element with a span anchor.

- `App.css`
  - Fixes `.xterm-helper-textarea` to `--output-dock-*` viewport coordinates
    while `.terminal-view.is-ime-docked`.
  - Makes the docked helper textarea invisible, including text and caret, so it
    remains an IME anchor without showing duplicate typed/composition text near
    the bottom of the terminal.
  - Hides `.composition-view` for the same reason.
  - Hides `.xterm-cursor` only while `.terminal-view.is-outputting`.
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

5. Invisible real dock anchor with fixed helper textarea during output.

   This was mostly stable after two important additions:

   - Add `terminal.onWriteParsed()` so ordinary streamed text triggers the dock,
     not only CSI-heavy TUI redraws.
   - Keep the docked helper textarea visually transparent. Otherwise typed or
     composing text can appear both at the real prompt and near the dock.

   However, the app could still briefly enter dock mode while the user was
   typing at an idle Codex prompt, because Codex can emit small redraw/control
   sequences even without visible AI output.

6. Always-on fixed helper textarea dock.

   This is the current approach. It gives up prompt-relative IME positioning in
   favor of a single stable dock position. This avoids edge cases where output
   detection, CSI detection, or release timing leaves the IME at a surprising
   position.

## Tradeoff

This approach intentionally gives up exact prompt-relative IME positioning. The
helper textarea is docked near the terminal bottom even when the user is typing
at an idle prompt.

The xterm cursor is still hidden only during parsed output bursts. Codex redraws
can otherwise show the cursor at intermediate output positions before returning
it to the prompt.

## Validation Checklist

Manual checks:

- Run `codex` inside the app terminal.
- Type Chinese at an idle Codex prompt and open the IME candidate bar.
- Let Codex stream normal text while the IME is active.
- Confirm the keyboard/candidate bar stays stable at the dock and does not jump
  to upper output rows.
- Confirm the bottom dock does not show duplicate typed/composition text.
- Confirm the xterm cursor does not jump through intermediate Codex output rows
  while Codex streams/redraws.
- Confirm normal typing still appears at the Codex prompt.
- Switch tabs and resize the terminal; confirm the helper textarea dock follows
  the current terminal geometry.

## Last Known Verification

- `npm run build` passed.
- Manual testing confirmed that the previous output-only dock was stable during
  output but could still appear while typing at an idle prompt. The current
  always-on dock intentionally makes that behavior consistent.
