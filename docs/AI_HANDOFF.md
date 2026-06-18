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
- Create terminal tabs with detected shell profiles.
- Restore saved projects and terminal tabs after app restart.
- Restart or close terminal tabs.
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
- settings dialog state

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

## Terminal Bugs To Watch

- xterm can throw if `fit()` runs while the element is detached.
- Do not call `terminal_create` before xterm is mounted.
- Closing a tab should call `terminal_close`.
- Restart should remove the tab id from `startedTerminals`.
- PTY output must be routed by `terminalId`; never broadcast output to all tabs.
- Keep hidden terminal views mounted so scrollback survives tab switching.

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
- Switch away and back
- Close and restart the app to confirm saved tabs restore
