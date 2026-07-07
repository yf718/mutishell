# AI Handoff Notes

This file is a compact guide for future AI agents modifying mutishell.

## Product Intent

mutishell is not an IDE. Keep it focused on fast terminal workspace management:

- sidebar = project folder launcher
- workspace = terminal tabs for the selected project
- backend = live PTY process owner
- frontend = UI and persisted workspace state owner

## Current MVP Behavior

- Add project folders from a native directory picker.
- Switch projects from the sidebar.
- Create up to 5 terminal tabs per project with detected shell profiles.
- Restore saved projects and terminal tabs after app restart.
- Restart or close terminal tabs.
- Close every terminal tab from the topbar. This clears saved tab definitions
  and closes all backend PTY processes.
- Drag the sidebar divider to persist a custom sidebar width.
- Scroll and sort the project list by dragging the row handle. Sorting is
  disabled while search is active.
- Toggle and persist light/dark UI theme.
- Save state automatically with a short debounce.
- Drag files onto the active terminal to insert quoted paths.
- Paste copied Explorer files or image-only clipboard screenshots into the
  active terminal as paths.
- Right-click in a terminal to open a minimal copy/paste menu. Paste reuses the
  copied-file and screenshot clipboard path handling before falling back to
  plain text.

## Important Files

- `src/App.tsx`
  - Main React state and user actions.
  - Good first file for UI behavior changes.
- `src/components/TerminalView.tsx`
  - xterm.js lifecycle.
  - Be careful with resize and dispose logic.
- `src/services/tauriApi.ts`
  - All frontend/backend command names.
  - Add wrappers here before using commands in UI.
- `src/utils/terminalPaths.ts`
  - Shell-aware path formatting for PowerShell, CMD, Git Bash, and WSL.
- `src/types.ts`
  - Frontend representation of Rust payloads.
- `src-tauri/src/lib.rs`
  - Rust commands, PTY registry, shell profile detection, JSON persistence.
- `docs/TERMINAL_FILE_INPUT.md`
  - Terminal file drag/drop, copied file paste, screenshot paste temp files, and
    cleanup behavior.

## Data Ownership

Rust owns:

- live terminal processes
- PTY readers/writers
- OS integration
- state file IO
- shell executable detection

React owns:

- project list
- saved tab definitions
- active project
- active tab per project
- sidebar width
- theme
- settings dialog state

Project order is stored directly in the `projects` array. Do not add a second
sort key unless the UI is changed to explain that sorting mode.

Do not put process handles or terminal output history into persisted React state.

## Adding A Tauri Command

1. Add the Rust function in `src-tauri/src/lib.rs`.
2. Add it to `tauri::generate_handler![...]`.
3. Add a typed wrapper in `src/services/tauriApi.ts`.
4. Add/update types in `src/types.ts`.
5. Run:

```powershell
npm run build
cd src-tauri
cargo check
```

## Adding A Shell Profile

Edit `default_shell_profiles()` in `src-tauri/src/lib.rs`.

Required fields:

- `id`
- `name`
- `executable`
- `args`
- `icon`
- `detected`

Keep profile IDs stable because saved tabs reference `shellProfileId`.

Users can edit a profile executable path in the settings dialog. The edited
profile is saved in `state.json` and passed back to Rust in
`TerminalCreateRequest.shellProfile`. Do not change launch code to only use
`default_shell_profiles()`, or custom Git Bash paths will stop working.
When hydrating saved profiles in React, do not overwrite a custom executable's
`detected` flag with the default profile detection result unless the executable
paths match.

Git Bash has one extra rule: `git-bash.exe` is a launcher and should be
normalized to the sibling `bin\bash.exe` before spawning the PTY. Keep
`--login -i` for interactive sessions.

## Terminal Bugs To Watch

- xterm can throw if `fit()` runs while the element is detached.
- Do not call `terminal_create` before xterm is mounted.
- Restored tabs must be started idempotently after both xterm and saved tabs are
  ready. Do not rely only on `TerminalView.onReady`; it can fire before React
  refs have the hydrated tab list.
- `startTerminal` must check that the tab still exists before and after
  `terminal_create`. Close-all may use a global launch generation, but
  close-tab and remove-project must cancel only the affected tab ids. If a
  close action wins the race while a terminal is starting, immediately call
  `terminal_close_instance` for that tab id and instance id so no invisible PTY
  is left running.
- Keep same-tab terminal launches serialized with `terminalLaunchTasks`.
  Restart can reuse a tab id, so output and exit events must also carry and
  match `instanceId`; otherwise an old PTY reader can remove or mark exited a
  newer process with the same tab id.
- Strip the Windows `\\?\` prefix before passing cwd to shells. CMD rejects it
  and falls back to `C:\Windows`.
- Closing a tab should call `terminal_close`.
- Closing all tabs should call `terminal_close_all`, clear `startedTerminals`,
  clear saved tabs, and reset active-tab selections.
- Restart should remove the tab id from `startedTerminals` and wait for any
  current launch task before starting the replacement.
- PTY output must be routed by `terminalId` and current `instanceId`; never
  broadcast output to all tabs.
- Frontend terminal output is flushed with `queueMicrotask`, not
  `requestAnimationFrame`. Some TUIs emit cursor moves in adjacent PTY chunks;
  delaying writes until the next frame can expose intermediate cursor positions.
- Codex CLI currently redraws in the normal buffer and repeatedly shows the
  cursor at intermediate locations before moving it back to the prompt. Keep the
  `TerminalView` `onWriteParsed` cursor-hiding debounce and
  `.terminal-view.is-outputting` CSS unless a better xterm-level fix is proven.
  The debounce is intentionally short (`64ms`) so normal shell prompts still show
  their cursor after output settles.
- Keep hidden terminal views mounted so scrollback survives tab switching.
- Do not hide inactive xterm mounts with `display: none`; it can make fit
  measure a tiny width and shrink the PTY after switching projects.
- Keep file drag/drop as a single App-level Tauri webview listener. Registering
  it inside every mounted terminal scales with total tab count.
- Terminal file insertion intentionally limits each operation to 10 paths.
- Paste handling lives in `TerminalView` capture phase so it can intercept
  image-only clipboard content before xterm's helper textarea consumes it.
- Keyboard paste and right-click paste should both call
  `src/utils/pasteManager.ts`. The paste manager calls
  `saveSystemClipboardFiles()` first, then writes text directly to the PTY with
  LF-normalized bracketed paste markers for multiline text. Do not fall back to
  xterm's own `terminal.paste(text)` path here; its CR newline normalization can
  split multiline input into submitted commands in TUIs such as Codex.
- The terminal right-click menu lives in `TerminalView` and should remain small:
  only copy and paste. Paste must call `saveSystemClipboardFiles()` first so
  Explorer file copies and screenshots keep working, then route text through
  the paste manager.
- Screenshot paste should prefer registered compressed image formats and fall
  back to Windows `CF_DIB` / `CF_DIBV5` bitmap data. Clipboard image payloads
  larger than 20 MB are rejected before copying them into process memory.
- Keep the xterm helper textarea anchored to the fixed bottom IME dock for
  Windows IME. Chinese input candidates can appear in the wrong screen location
  in WebView2 if the helper textarea keeps its off-screen default position.
- During IME composition, show the bottom dock as an overlay only. Do not shrink
  the terminal mount or re-fit xterm during composition; that makes terminal rows
  jump while typing.
- Current per-project tab limit is `MAX_TERMINALS_PER_PROJECT = 5` in
  `src/App.tsx`.

## Packaging

The default bundle target is NSIS only in `src-tauri/tauri.conf.json`. Avoid
switching back to `targets: "all"` casually; on Windows the MSI and NSIS
patching steps can briefly contend for `target\release\mutishell.exe` and emit
`os error 32`.

## Safe Next Features

Recommended order:

1. Custom shell profile editor.
2. Tab drag reorder.
3. Project rename and grouping.
4. Command templates.
5. Split panes.
6. Optional terminal output snapshot.

## Style Direction

The app should feel like a focused desktop tool:

- dense enough for repeated daily use
- restrained colors
- terminal-first layout
- no landing page
- no marketing hero
- avoid decorative backgrounds

## Verification Checklist

Before handing off changes:

- `npm run build`
- `cd src-tauri && cargo check`
- `npm run tauri dev` launches
- Add a project folder
- Open PowerShell
- Type a command
- Confirm the current project refuses the 6th terminal tab
- Drag the sidebar narrower and restart to confirm the width restores
- Drag-sort projects and restart to confirm the order restores
- Toggle light/dark theme and restart to confirm the theme restores
- Drag a local file onto PowerShell and confirm a quoted path is inserted
- Copy a file from Explorer and paste into the terminal
- Copy a screenshot and confirm a temp file path is inserted
- Switch away and back
- Click the topbar close-all-terminal button and confirm all project tab counts
  return to zero
- Close and restart the app to confirm saved tabs restore
