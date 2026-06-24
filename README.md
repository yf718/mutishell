# mutishell

mutishell is a Windows-first terminal workspace manager built with Tauri, Rust,
React, and xterm.js.

The first MVP focuses on one workflow:

1. Keep a left sidebar of project folders.
2. Open up to 5 terminal tabs per project folder.
3. Support PowerShell, PowerShell 7, CMD, Git Bash, and WSL profiles.
4. Remember projects, tabs, active project, active tab, sidebar width, and theme before closing.
5. Restore the previous workspace on the next launch.
6. Scroll and reorder projects with the drag handle when many folders are configured.
7. Insert file paths into the active terminal by dragging files, pasting copied
   Explorer files, or pasting image-only clipboard content such as screenshots.
8. Use a terminal right-click menu with copy and paste actions. Paste reuses the
   same text, copied-file, and image clipboard handling as keyboard paste.

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- PTY: `portable-pty`
- Frontend: React 19 + TypeScript + Vite
- Terminal renderer: `@xterm/xterm` + `@xterm/addon-fit`
- Icons: `lucide-react`
- State storage: JSON file under the user config directory

## Local Environment

Required tools on Windows:

- Node.js 20+
- npm
- Rust stable MSVC toolchain
- Visual Studio 2022 Build Tools with C++ workload
- WebView2 Runtime

This repo also includes `.cargo/config.toml` to use the `rsproxy.cn` sparse
Cargo mirror. npm can be accelerated with:

```powershell
npm config set registry https://registry.npmmirror.com
```

Useful checks:

```powershell
node --version
npm --version
rustc --version
cargo --version
```

If Rust was just installed and the current terminal cannot find it:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

## Development

Install dependencies:

```powershell
npm install
```

Run the app:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri dev
```

Frontend-only build:

```powershell
npm run build
```

Rust-only check:

```powershell
cd src-tauri
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo check
```

Desktop package build:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri build
```

The default bundle target is NSIS only. Building both MSI and NSIS in the same
run can make Windows briefly lock the release executable while Tauri patches
bundle metadata.

## Project Structure

```text
src/
  App.tsx                     Main workspace UI and state orchestration
  App.css                     Application layout and component styling
  types.ts                    Shared frontend data types
  components/
    TerminalView.tsx          xterm.js lifecycle, input, resize handling
  services/
    tauriApi.ts               Tauri commands and event wrappers
  utils/
    terminalPaths.ts          Shell-aware terminal path quoting

src-tauri/
  Cargo.toml                  Rust dependencies
  tauri.conf.json             Window, bundle, app metadata
  capabilities/default.json   Tauri permission allowlist
  src/
    lib.rs                    PTY backend, app state, shell detection
    main.rs                   Tauri binary entry
```

## Runtime Data

State is saved to:

```text
%APPDATA%\mutishell\state.json
```

The state file shape is:

```json
{
  "version": 1,
  "projects": [],
  "tabs": [],
  "activeProjectId": null,
  "activeTabByProject": {},
  "shellProfiles": [],
  "defaultShellProfileId": "powershell",
  "sidebarWidth": 260,
  "theme": "dark"
}
```

Terminal scrollback output is not persisted in the MVP. Only tab definitions,
working directories, shell profile IDs, and active selections are restored.

## Backend Commands

Defined in `src-tauri/src/lib.rs`:

- `load_app_state() -> AppStateFile`
- `save_app_state(state: AppStateFile)`
- `get_shell_profiles() -> ShellProfile[]`
- `get_home_dir() -> string`
- `open_path_in_explorer(path: string)`
- `save_system_clipboard_files() -> string[]`
- `clear_paste_temp_files() -> number`
- `terminal_create(request: TerminalCreateRequest) -> TerminalCreated`
- `terminal_write(terminalId: string, data: string)`
- `terminal_resize(terminalId: string, cols: number, rows: number)`
- `terminal_close(terminalId: string)`

Backend events:

- `terminal://data`
  - payload: `{ terminalId: string, data: string }`
- `terminal://exit`
  - payload: `{ terminalId: string }`

## Terminal Lifecycle

1. Frontend creates a `RuntimeTab`.
2. `TerminalView` mounts xterm.js.
3. Frontend calls `terminal_create`.
4. Rust starts `portable-pty` with the selected shell profile and cwd.
5. Rust reads PTY output on a background thread.
6. Rust emits `terminal://data`.
7. Frontend writes data into the matching xterm instance.
8. xterm input calls `terminal_write`.
9. ResizeObserver calls `terminal_resize`.
10. Closing a tab calls `terminal_close`.

File input uses the same terminal write path. `App.tsx` owns one Tauri
drag/drop listener for the active terminal. `TerminalView.tsx` handles paste
events before xterm consumes them, owns a small terminal right-click menu for
copy/paste, and `src/utils/terminalPaths.ts` formats paths for PowerShell, CMD,
Git Bash, and WSL. A single drag/drop or copied-file paste inserts at most 10
paths; image-only clipboard content is capped at 20 MB.

## Shell Profiles

Default profiles are generated in Rust:

- `powershell`: Windows PowerShell
- `pwsh`: PowerShell 7
- `cmd`: Command Prompt
- `git-bash`: Git Bash
- `wsl`: WSL

The app detects whether the executable exists. Profile executable paths can be
edited in the settings dialog, validated with the `check_executable_path` Tauri
command, and persisted in `state.json`.

For Git Bash, users may enter either `bin\bash.exe` or the Git for Windows
launcher `git-bash.exe`. Launch code normalizes `git-bash.exe` to the sibling
`bin\bash.exe` and ensures `--login -i` is present, because the launcher opens
its own window and exits instead of staying attached to the embedded PTY.

When launching a terminal, the frontend sends the saved `ShellProfile` to Rust.
This is important because users may install Git Bash outside
`C:\Program Files\Git`.

## Design Notes For Future AI Changes

- Keep Tauri command names centralized in `src/services/tauriApi.ts`.
- Keep frontend data contracts in `src/types.ts`.
- Avoid storing terminal process state in React. Rust owns live PTY processes.
- React owns user workspace state: projects, tabs, active selections, sidebar width, and theme.
- Project order is the array order in `projects`; handle-based sorting mutates
  this array and is disabled while filtering via search.
- Keep inactive terminal views mounted but hidden with visibility/opacity, not
  `display: none`; xterm fit can mis-measure hidden terminals and shrink the
  backend PTY if the mount has no real size.
- Add new Rust commands to `invoke_handler` and expose matching wrappers in
  `tauriApi.ts`.
- Keep terminal file path quoting centralized in `src/utils/terminalPaths.ts`.
- Keep drag/drop handling App-level so it does not register one global listener
  per mounted terminal tab.
- Keep terminal right-click paste wired through `save_system_clipboard_files`
  first, then fall back to `terminal.paste(text)`. This preserves copied-file
  and screenshot paste behavior while letting xterm handle bracketed paste for
  text.
- Keep Windows IME anchored to the fixed bottom dock in `TerminalView`. Do not
  resize/refit xterm during composition because that makes terminal rows jump
  while typing.
- If splitting `App.tsx`, move project/tab mutations into a small store first,
  then split visual components.
- Do not persist large terminal output by default. It can make startup slow and
  state files huge.
- For performance, keep inactive xterm instances mounted but hidden. This keeps
  scrollback and terminal state alive while switching tabs.
- Each project is intentionally limited to 5 terminal tabs in the MVP. Update
  `MAX_TERMINALS_PER_PROJECT` in `src/App.tsx` if this changes.

## Known MVP Limits

- No split panes yet.
- Each project is capped at 5 terminal tabs.
- Shell profile path editing exists, but adding/removing profiles is not exposed yet.
- No terminal output persistence.
- No drag reorder for terminal tabs.
- No SSH manager.
- No command/task templates.

These are good next features once the MVP is stable.
