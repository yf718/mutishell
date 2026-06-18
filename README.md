# mutishell

mutishell is a Windows-first terminal workspace manager built with Tauri, Rust,
React, and xterm.js.

The first MVP focuses on one workflow:

1. Keep a left sidebar of project folders.
2. Open multiple terminal tabs per project folder.
3. Support PowerShell, PowerShell 7, CMD, Git Bash, and WSL profiles.
4. Remember projects, tabs, active project, and active tab before closing.
5. Restore the previous workspace on the next launch.

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
  "defaultShellProfileId": "powershell"
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

## Shell Profiles

Default profiles are generated in Rust:

- `powershell`: Windows PowerShell
- `pwsh`: PowerShell 7
- `cmd`: Command Prompt
- `git-bash`: Git Bash
- `wsl`: WSL

The MVP detects whether the executable exists. Editing custom profile paths is
not implemented yet, but the data model already supports profile persistence.

## Design Notes For Future AI Changes

- Keep Tauri command names centralized in `src/services/tauriApi.ts`.
- Keep frontend data contracts in `src/types.ts`.
- Avoid storing terminal process state in React. Rust owns live PTY processes.
- React owns user workspace state: projects, tabs, active selections.
- Add new Rust commands to `invoke_handler` and expose matching wrappers in
  `tauriApi.ts`.
- If splitting `App.tsx`, move project/tab mutations into a small store first,
  then split visual components.
- Do not persist large terminal output by default. It can make startup slow and
  state files huge.
- For performance, keep inactive xterm instances mounted but hidden. This keeps
  scrollback and terminal state alive while switching tabs.

## Known MVP Limits

- No split panes yet.
- No custom shell profile editor yet.
- No terminal output persistence.
- No drag reorder for project items or tabs.
- No SSH manager.
- No command/task templates.

These are good next features once the MVP is stable.
