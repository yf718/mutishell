export type ShellProfile = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  icon: string;
  detected: boolean;
};

export type AppTheme = "light" | "dark";

export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
};

export type SavedTab = {
  id: string;
  projectId: string;
  title: string;
  shellProfileId: string;
  cwd: string;
  createdAt: string;
};

export type AppStateFile = {
  version: number;
  projects: Project[];
  tabs: SavedTab[];
  activeProjectId: string | null;
  activeTabByProject: Record<string, string>;
  shellProfiles: ShellProfile[];
  defaultShellProfileId: string;
  sidebarWidth?: number;
  theme?: AppTheme;
  rightClickPaste?: boolean;
  copyOnSelect?: boolean;
};

export type TerminalCreateRequest = {
  terminalId?: string;
  terminalInstanceId?: string;
  shellProfileId: string;
  shellProfile?: ShellProfile;
  cwd: string;
  title?: string;
  cols?: number;
  rows?: number;
};

export type TerminalCreated = {
  id: string;
  instanceId: string;
  pid?: number;
};

export type TerminalDataEvent = {
  terminalId: string;
  instanceId: string;
  data: string;
};

export type TerminalExitEvent = {
  terminalId: string;
  instanceId: string;
};

export type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

export type RuntimeTab = SavedTab & {
  status: TerminalStatus;
  error?: string;
};
