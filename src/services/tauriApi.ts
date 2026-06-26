import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppStateFile,
  ShellProfile,
  TerminalCreateRequest,
  TerminalCreated,
  TerminalDataEvent,
  TerminalExitEvent,
} from "../types";

export function loadAppState(): Promise<AppStateFile> {
  return invoke("load_app_state");
}

export function saveAppState(state: AppStateFile): Promise<void> {
  return invoke("save_app_state", { state });
}

export function getShellProfiles(): Promise<ShellProfile[]> {
  return invoke("get_shell_profiles");
}

export function checkExecutablePath(path: string): Promise<boolean> {
  return invoke("check_executable_path", { path });
}

export function getHomeDir(): Promise<string> {
  return invoke("get_home_dir");
}

export function openPathInExplorer(path: string): Promise<void> {
  return invoke("open_path_in_explorer", { path });
}

export function clearPasteTempFiles(): Promise<number> {
  return invoke("clear_paste_temp_files");
}

export function saveSystemClipboardFiles(): Promise<string[]> {
  return invoke("save_system_clipboard_files");
}

export function createTerminal(
  request: TerminalCreateRequest,
): Promise<TerminalCreated> {
  return invoke("terminal_create", { request });
}

export function writeTerminal(terminalId: string, data: string): Promise<void> {
  return invoke("terminal_write", { terminalId, data });
}

export function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { terminalId, cols, rows });
}

export function closeTerminal(terminalId: string): Promise<void> {
  return invoke("terminal_close", { terminalId });
}

export function closeTerminalInstance(
  terminalId: string,
  instanceId: string,
): Promise<void> {
  return invoke("terminal_close_instance", { terminalId, instanceId });
}

export function closeAllTerminals(): Promise<void> {
  return invoke("terminal_close_all");
}

export function onTerminalData(
  callback: (event: TerminalDataEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalDataEvent>("terminal://data", (event) => {
    callback(event.payload);
  });
}

export function onTerminalExit(
  callback: (event: TerminalExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalExitEvent>("terminal://exit", (event) => {
    callback(event.payload);
  });
}

export async function pickProjectDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择项目目录",
  });

  return typeof selected === "string" ? selected : null;
}
