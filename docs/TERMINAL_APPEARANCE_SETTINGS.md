# Terminal Appearance And Settings

This note documents the July 2026 terminal appearance changes.

## Scope

- Light and dark UI theme now also drive xterm.js terminal colors.
- Terminal mount, viewport, canvas, scrollbar, and terminal context menu colors
  use theme variables.
- Terminal font size is configurable from Settings and persists in app state.
- The unused tab rename action was removed.

## Terminal Theme Behavior

`TerminalView` owns the xterm.js color palette. The dark palette keeps the
previous terminal look. The light palette defines default foreground/background,
ANSI colors, selection colors, cursor colors, and a 16-255 extended ANSI map so
common TUI panels that use 256-color dark grays render closer to the light UI.

Theme changes update existing terminal instances at runtime through
`terminal.options.theme`, followed by texture atlas clearing and a refresh. PTY
processes are not restarted.

Some full-screen TUIs, such as tools with their own theme system, can still
paint dark regions using direct RGB escape sequences. Prefer configuring the
tool's own theme rather than rewriting terminal output streams.

## Font Size Setting

`terminalFontSize` is stored in the persisted app state.

- Default: `13`
- Minimum: `11`
- Maximum: `22`

The Settings dialog exposes a range slider and number input. Changing the value
updates mounted xterm instances immediately, then refits and refreshes them.

## IME And Cursor Handling

xterm owns the helper textarea and composition view. When a native IME
composition begins, mutishell pauses frontend output delivery for that terminal
and defers fitting, refreshes, and texture-atlas rebuilding. The PTY continues
to run; accumulated bytes are delivered after xterm commits the composed text.

The cursor-hiding debounce during output also remains in place. It only hides
the visible cursor briefly while output is being parsed; it does not alter PTY
data or terminal scrollback.

## Removed Behavior

The current-tab rename action was removed because it was not useful in practice.

Removed entry points:

- Toolbar rename button.
- Double-click tab rename.
- `renameActiveTab` callback.
- `Pencil` icon import.

## Transcript Notes

Codex and similar TUI tools can update their current screen using cursor
movement and clear-line escape sequences. The terminal screen and scrollback are
therefore not guaranteed to match the tool's internal conversation transcript.
For a complete transcript, use the tool's own resume/history feature.

No terminal-output stream rewriting is implemented for this. Rewriting ANSI
control sequences would risk breaking normal terminal behavior and full-screen
TUIs.

## Verification

- `npm run build` passes.
- Light terminal background, Codex input panel, bottom terminal edge, and
  terminal right-click menu render in the light palette.
- Terminal font size changes apply to existing tabs without restarting the
  shell process.
