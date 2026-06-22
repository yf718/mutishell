use chrono::Utc;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Listener, Manager};
use uuid::Uuid;

const APP_DIR_NAME: &str = "mutishell";
const STATE_FILE_NAME: &str = "state.json";

type AppResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub icon: String,
    pub detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub shell_profile_id: String,
    pub cwd: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFile {
    pub version: u32,
    pub projects: Vec<Project>,
    pub tabs: Vec<SavedTab>,
    pub active_project_id: Option<String>,
    pub active_tab_by_project: HashMap<String, String>,
    pub shell_profiles: Vec<ShellProfile>,
    pub default_shell_profile_id: String,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: f64,
    #[serde(default = "default_theme")]
    pub theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateRequest {
    pub terminal_id: Option<String>,
    pub shell_profile_id: String,
    pub shell_profile: Option<ShellProfile>,
    pub cwd: String,
    pub title: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreated {
    pub id: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub terminal_id: String,
}

struct TerminalProcess {
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
struct TerminalRegistry {
    terminals: Mutex<HashMap<String, TerminalProcess>>,
}

impl TerminalRegistry {
    fn insert(&self, id: String, terminal: TerminalProcess) -> AppResult<()> {
        let mut terminals = self.terminals.lock().map_err(lock_error)?;
        terminals.insert(id, terminal);
        Ok(())
    }

    fn write(&self, id: &str, data: &str) -> AppResult<()> {
        let mut terminals = self.terminals.lock().map_err(lock_error)?;
        let terminal = terminals
            .get_mut(id)
            .ok_or_else(|| format!("Terminal '{id}' is not running"))?;
        terminal
            .writer
            .write_all(data.as_bytes())
            .map_err(|err| format!("Failed to write terminal input: {err}"))?;
        terminal
            .writer
            .flush()
            .map_err(|err| format!("Failed to flush terminal input: {err}"))?;
        Ok(())
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let terminals = self.terminals.lock().map_err(lock_error)?;
        let terminal = terminals
            .get(id)
            .ok_or_else(|| format!("Terminal '{id}' is not running"))?;
        terminal
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("Failed to resize terminal: {err}"))
    }

    fn close(&self, id: &str) -> AppResult<()> {
        let terminal = {
            let mut terminals = self.terminals.lock().map_err(lock_error)?;
            terminals.remove(id)
        };
        if let Some(mut terminal) = terminal {
            terminal.alive.store(false, Ordering::SeqCst);
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
        }
        Ok(())
    }

    fn close_all(&self) {
        let terminals: Result<Vec<TerminalProcess>, _> = self
            .terminals
            .lock()
            .map(|mut terminals| terminals.drain().map(|(_, terminal)| terminal).collect());
        if let Ok(terminals) = terminals {
            for mut terminal in terminals {
                terminal.alive.store(false, Ordering::SeqCst);
                let _ = terminal.child.kill();
                let _ = terminal.child.wait();
            }
        }
    }
}

#[tauri::command]
fn load_app_state() -> AppResult<AppStateFile> {
    let path = state_file_path()?;
    if !path.exists() {
        return Ok(default_app_state());
    }

    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read state file '{}': {err}", path.display()))?;
    let mut state: AppStateFile = serde_json::from_str(&content)
        .map_err(|err| format!("Failed to parse state file '{}': {err}", path.display()))?;

    let detected_profiles = default_shell_profiles();
    for profile in &mut state.shell_profiles {
        if let Some(detected) = detected_profiles.iter().find(|item| item.id == profile.id) {
            if profile.executable.trim().is_empty() {
                profile.executable = detected.executable.clone();
            }
        }
        profile.detected = executable_exists(&profile.executable);
    }

    if state.shell_profiles.is_empty() {
        state.shell_profiles = detected_profiles;
        state.default_shell_profile_id = default_shell_id(&state.shell_profiles);
    } else {
        for detected in detected_profiles {
            if !state.shell_profiles.iter().any(|item| item.id == detected.id) {
                state.shell_profiles.push(detected);
            }
        }
        if !state
            .shell_profiles
            .iter()
            .any(|item| item.id == state.default_shell_profile_id && item.detected)
        {
            state.default_shell_profile_id = default_shell_id(&state.shell_profiles);
        }
    }

    Ok(state)
}

#[tauri::command]
fn save_app_state(state: AppStateFile) -> AppResult<()> {
    let path = state_file_path()?;
    ensure_parent_dir(&path)?;
    let content = serde_json::to_string_pretty(&state)
        .map_err(|err| format!("Failed to serialize state: {err}"))?;
    fs::write(&path, content)
        .map_err(|err| format!("Failed to write state file '{}': {err}", path.display()))
}

#[tauri::command]
fn get_shell_profiles() -> Vec<ShellProfile> {
    default_shell_profiles()
}

#[tauri::command]
fn check_executable_path(path: String) -> bool {
    executable_exists(&path)
        || normalize_git_bash_executable(&clean_executable_path(&path))
            .is_some_and(|bash| executable_exists(&bash))
}

#[tauri::command]
fn get_home_dir() -> AppResult<String> {
    dirs::home_dir()
        .map(path_to_string)
        .ok_or_else(|| "Unable to locate home directory".to_string())
}

#[tauri::command]
fn open_path_in_explorer(path: String) -> AppResult<()> {
    let normalized = normalize_existing_dir(&path)?;
    Command::new("explorer")
        .arg(normalized)
        .spawn()
        .map_err(|err| format!("Failed to open explorer: {err}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_create(
    app: AppHandle,
    registry: tauri::State<'_, TerminalRegistry>,
    request: TerminalCreateRequest,
) -> AppResult<TerminalCreated> {
    let terminal_id = request
        .terminal_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let default_profile = default_shell_profiles()
        .into_iter()
        .find(|item| item.id == request.shell_profile_id)
        .ok_or_else(|| format!("Unknown shell profile '{}'", request.shell_profile_id))?;
    let profile = request
        .shell_profile
        .filter(|profile| profile.id == request.shell_profile_id)
        .unwrap_or(default_profile);

    let cwd = normalize_existing_dir(&request.cwd)?;
    let launch = resolve_shell_launch(&profile);
    let executable = launch.executable;
    if !executable_exists(&executable) {
        return Err(format!(
            "Shell '{}' was not found at '{}'",
            profile.name, executable
        ));
    }

    registry.close(&terminal_id)?;

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: request.rows.unwrap_or(30).max(1),
            cols: request.cols.unwrap_or(100).max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("Failed to open PTY: {err}"))?;

    let mut command = CommandBuilder::new(&executable);
    for arg in &launch.args {
        command.arg(arg);
    }
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("Failed to spawn '{}': {err}", profile.name))?;
    let pid = child.process_id();
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|err| format!("Failed to open terminal writer: {err}"))?;
    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("Failed to open terminal reader: {err}"))?;

    let alive = Arc::new(AtomicBool::new(true));
    let alive_for_reader = alive.clone();
    let app_for_reader = app.clone();
    let terminal_id_for_reader = terminal_id.clone();

    thread::Builder::new()
        .name(format!("terminal-reader-{terminal_id}"))
        .spawn(move || {
            let mut buffer = [0_u8; 32768];
            while alive_for_reader.load(Ordering::SeqCst) {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                        let _ = app_for_reader.emit(
                            "terminal://data",
                            TerminalDataEvent {
                                terminal_id: terminal_id_for_reader.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }

            let _ = app_for_reader.emit(
                "terminal://exit",
                TerminalExitEvent {
                    terminal_id: terminal_id_for_reader,
                },
            );
        })
        .map_err(|err| format!("Failed to start terminal reader: {err}"))?;

    registry.insert(
        terminal_id.clone(),
        TerminalProcess {
            writer,
            child,
            master: pty_pair.master,
            alive,
        },
    )?;

    Ok(TerminalCreated {
        id: terminal_id,
        pid,
    })
}

#[tauri::command]
fn terminal_write(
    registry: tauri::State<'_, TerminalRegistry>,
    terminal_id: String,
    data: String,
) -> AppResult<()> {
    registry.write(&terminal_id, &data)
}

#[tauri::command]
fn terminal_resize(
    registry: tauri::State<'_, TerminalRegistry>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    registry.resize(&terminal_id, cols, rows)
}

#[tauri::command]
fn terminal_close(
    registry: tauri::State<'_, TerminalRegistry>,
    terminal_id: String,
) -> AppResult<()> {
    registry.close(&terminal_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalRegistry::default())
        .invoke_handler(tauri::generate_handler![
            load_app_state,
            save_app_state,
            get_shell_profiles,
            check_executable_path,
            get_home_dir,
            open_path_in_explorer,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            app.listen("tauri://close-requested", move |_| {
                let registry = app_handle.state::<TerminalRegistry>();
                registry.close_all();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn default_app_state() -> AppStateFile {
    let shell_profiles = default_shell_profiles();
    AppStateFile {
        version: 1,
        projects: Vec::new(),
        tabs: Vec::new(),
        active_project_id: None,
        active_tab_by_project: HashMap::new(),
        default_shell_profile_id: default_shell_id(&shell_profiles),
        shell_profiles,
        sidebar_width: default_sidebar_width(),
        theme: default_theme(),
    }
}

fn default_sidebar_width() -> f64 {
    260.0
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_shell_profiles() -> Vec<ShellProfile> {
    let mut profiles = vec![
        ShellProfile {
            id: "powershell".to_string(),
            name: "Windows PowerShell".to_string(),
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string()],
            icon: "square-terminal".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "pwsh".to_string(),
            name: "PowerShell 7".to_string(),
            executable: find_first_existing(&[
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                "C:\\Program Files\\PowerShell\\6\\pwsh.exe",
            ])
            .unwrap_or_else(|| "pwsh.exe".to_string()),
            args: vec!["-NoLogo".to_string()],
            icon: "terminal".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            executable: "C:\\Windows\\System32\\cmd.exe".to_string(),
            args: Vec::new(),
            icon: "panel-top".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "git-bash".to_string(),
            name: "Git Bash".to_string(),
            executable: find_first_existing(&[
                "C:\\Program Files\\Git\\bin\\bash.exe",
                "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
                "D:\\Git\\bin\\bash.exe",
                "D:\\Program Files\\Git\\bin\\bash.exe",
                "D:\\Program Files (x86)\\Git\\bin\\bash.exe",
            ])
            .unwrap_or_else(|| "C:\\Program Files\\Git\\bin\\bash.exe".to_string()),
            args: vec!["--login".to_string(), "-i".to_string()],
            icon: "git-branch".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "wsl".to_string(),
            name: "WSL".to_string(),
            executable: "C:\\Windows\\System32\\wsl.exe".to_string(),
            args: Vec::new(),
            icon: "box".to_string(),
            detected: false,
        },
    ];

    for profile in &mut profiles {
        profile.detected = executable_exists(&profile.executable);
    }

    profiles
}

fn default_shell_id(profiles: &[ShellProfile]) -> String {
    profiles
        .iter()
        .find(|profile| profile.id == "powershell" && profile.detected)
        .or_else(|| profiles.iter().find(|profile| profile.detected))
        .map(|profile| profile.id.clone())
        .unwrap_or_else(|| "powershell".to_string())
}

fn state_file_path() -> AppResult<PathBuf> {
    let base_dir = dirs::config_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "Unable to locate user config directory".to_string())?;
    Ok(base_dir.join(APP_DIR_NAME).join(STATE_FILE_NAME))
}

fn ensure_parent_dir(path: &Path) -> AppResult<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create config directory '{}': {err}", parent.display()))
}

fn normalize_existing_dir(path: &str) -> AppResult<String> {
    let path = shellexpand_home(path);
    let path = PathBuf::from(path);
    let canonical = fs::canonicalize(&path)
        .map_err(|err| format!("Directory '{}' does not exist: {err}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("'{}' is not a directory", canonical.display()));
    }
    Ok(clean_windows_path(&path_to_string(canonical)))
}

fn shellexpand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return path_to_string(home.join(rest));
        }
    }
    path.to_string()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn clean_executable_path(path: &str) -> String {
    clean_windows_path(path.trim().trim_matches('"'))
}

struct ShellLaunch {
    executable: String,
    args: Vec<String>,
}

fn resolve_shell_launch(profile: &ShellProfile) -> ShellLaunch {
    let executable = clean_executable_path(&profile.executable);
    let args = if profile.id == "git-bash" {
        ensure_git_bash_args(&profile.args)
    } else {
        profile.args.clone()
    };

    ShellLaunch {
        executable: normalize_git_bash_executable(&executable).unwrap_or(executable),
        args,
    }
}

fn ensure_git_bash_args(args: &[String]) -> Vec<String> {
    if args.iter().any(|arg| arg == "--login") && args.iter().any(|arg| arg == "-i") {
        return args.to_vec();
    }

    let mut next = args.to_vec();
    if !next.iter().any(|arg| arg == "--login") {
        next.push("--login".to_string());
    }
    if !next.iter().any(|arg| arg == "-i") {
        next.push("-i".to_string());
    }
    next
}

fn normalize_git_bash_executable(executable: &str) -> Option<String> {
    let path = Path::new(executable);
    let file_name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if file_name != "git-bash.exe" {
        return None;
    }

    let git_root = path.parent()?;
    let bash = git_root.join("bin").join("bash.exe");
    if bash.exists() {
        return Some(path_to_string(bash));
    }

    None
}

fn clean_windows_path(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{stripped}");
    }
    if let Some(stripped) = path.strip_prefix(r"\\?\") {
        return stripped.to_string();
    }
    path.to_string()
}

fn find_first_existing(paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .find(|path| Path::new(path).exists())
        .map(|path| (*path).to_string())
}

fn executable_exists(executable: &str) -> bool {
    let executable = clean_executable_path(executable);
    let executable = executable.trim();
    if executable.is_empty() {
        return false;
    }
    if Path::new(executable).exists() {
        return true;
    }

    let Ok(path_env) = std::env::var("PATH") else {
        return false;
    };

    let path = Path::new(executable);
    let candidates: Vec<String> = if path.extension().is_some() {
        vec![executable.to_string()]
    } else {
        vec![format!("{executable}.exe"), executable.to_string()]
    };

    std::env::split_paths(&path_env).any(|dir| {
        candidates
            .iter()
            .any(|candidate| dir.join(candidate).exists())
    })
}

fn lock_error<T>(err: std::sync::PoisonError<T>) -> String {
    format!("Internal state lock failed: {err}")
}

#[allow(dead_code)]
fn now_string() -> String {
    Utc::now().to_rfc3339()
}
