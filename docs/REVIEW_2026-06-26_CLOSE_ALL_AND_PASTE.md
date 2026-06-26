# Review: close-all terminals and paste handling

Date: 2026-06-26

## Scope

This review covered the current working tree changes for:

- Topbar close-all-terminal action.
- Backend `terminal_close_all` command.
- Terminal launch cancellation during close-tab, remove-project, restart, and close-all flows.
- Keyboard and right-click paste behavior for text, copied Explorer files, and screenshots.
- Related README and docs updates.

## Findings

### Keyboard paste did not match right-click paste

`TerminalView` handled `text/plain` paste events by immediately calling
`terminal.paste(text)`. Right-click paste used a different order:

1. Call `saveSystemClipboardFiles()`.
2. Insert copied Explorer file paths or generated screenshot temp paths.
3. Fall back to text via `terminal.paste(text)`.

That difference could make `Ctrl+V` ignore copied-file clipboard data when the
WebView also exposed a text representation. This would break the expected file
path insertion behavior.

Resolution:

- Keyboard paste now prevents the browser default, calls
  `saveSystemClipboardFiles()` first, and only falls back to
  `terminal.paste(text)` when no file or screenshot paths are returned.
- Text fallback still uses xterm `terminal.paste(text)` so multiline paste keeps
  bracketed paste semantics in TUIs.

Files:

- `src/components/TerminalView.tsx`
- `docs/AI_HANDOFF.md`
- `docs/TERMINAL_FILE_INPUT.md`

### Pending auto-create could race with close-all

`addProject` schedules automatic default terminal creation with a short timeout.
If close-all started before that timeout fired, the pending auto-create could run
after close-all finished and create a new terminal tab.

Resolution:

- `App.tsx` now tracks pending auto-create timer ids in
  `pendingAutoCreateTimers`.
- The timer removes itself from the set when it fires.
- `closeAllTabs()` clears all pending auto-create timers before starting the
  close-all operation.

Files:

- `src/App.tsx`

## Existing close-all behavior reviewed

The close-all flow now:

- Calls frontend `closeAllTabs()`.
- Disables terminal create/restart controls while close-all is in progress.
- Calls backend `terminal_close_all`.
- Clears `startedTerminals`, terminal output queues, terminal size refs, tab
  state, and active-tab selections.
- Uses `closeAllGeneration`, `closeAllInProgress`, and
  `cancelledTerminalLaunches` so terminal launches that lose the race are either
  abandoned before spawn or immediately closed after `terminal_create` returns.
- Tags every backend terminal process with a frontend `instanceId` and serializes
  same-tab launches, so restart cannot let an older reader thread remove or
  mark exited a newer process that reused the same tab id.

Backend `TerminalRegistry::close_all()` drains the registry under lock, then
kills and waits each child process outside the lock.

## Verification Performed

Command:

```powershell
npm exec tsc -- --noEmit --pretty false
cargo check
```

Result: passed.

`cargo fmt --check` was attempted during review, but the local Rust toolchain
does not have `rustfmt` installed.

`cargo check` passed after sandbox permissions allowed writing
`src-tauri/target`.

## Manual Regression Checklist

- Copy text and press `Ctrl+V` in a terminal. Multiline text should arrive as
  one bracketed paste in TUIs such as Codex.
- Copy a file from Explorer and press `Ctrl+V`. The terminal should receive the
  shell-quoted original file path.
- Copy a file from Explorer, right-click the terminal, and choose paste. It
  should match keyboard paste behavior.
- Copy a screenshot and press `Ctrl+V`. The terminal should receive a generated
  path under `%TEMP%\mutishell\paste-temp`.
- Add a project and immediately click close-all before the default terminal
  auto-creates. No terminal tab should appear afterward.
- Start a terminal and click close-all while it is starting. No hidden PTY should
  remain running.
- Close all terminals and restart the app. Saved terminal tabs should stay empty.
