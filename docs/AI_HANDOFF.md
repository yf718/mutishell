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
- Drag the sidebar divider to persist a custom sidebar width.
- Scroll and sort the project list by dragging the row handle. Sorting is
  disabled while search is active.
- Toggle and persist light/dark UI theme.
- Save state automatically with a short debounce.

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
- `src/types.ts`
  - Frontend representation of Rust payloads.
- `src-tauri/src/lib.rs`
  - Rust commands, PTY registry, shell profile detection, JSON persistence.

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

Git Bash has one extra rule: `git-bash.exe` is a launcher and should be
normalized to the sibling `bin\bash.exe` before spawning the PTY. Keep
`--login -i` for interactive sessions.

## Terminal Bugs To Watch

- xterm can throw if `fit()` runs while the element is detached.
- Do not call `terminal_create` before xterm is mounted.
- Strip the Windows `\\?\` prefix before passing cwd to shells. CMD rejects it
  and falls back to `C:\Windows`.
- Closing a tab should call `terminal_close`.
- Restart should remove the tab id from `startedTerminals`.
- PTY output must be routed by `terminalId`; never broadcast output to all tabs.
- Keep hidden terminal views mounted so scrollback survives tab switching.
- Do not hide inactive xterm mounts with `display: none`; it can make fit
  measure a tiny width and shrink the PTY after switching projects.
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
- Switch away and back
- Close and restart the app to confirm saved tabs restore
