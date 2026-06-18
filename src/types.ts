export type ShellProfile = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  icon: string;
  detected: boolean;
};

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
};

export type TerminalCreateRequest = {
  terminalId?: string;
  shellProfileId: string;
  shellProfile?: ShellProfile;
  cwd: string;
  title?: string;
  cols?: number;
  rows?: number;
};

export type TerminalCreated = {
  id: string;
  pid?: number;
};

export type TerminalDataEvent = {
  terminalId: string;
  data: string;
};

export type TerminalExitEvent = {
  terminalId: string;
};

export type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

export type RuntimeTab = SavedTab & {
  status: TerminalStatus;
  error?: string;
};
