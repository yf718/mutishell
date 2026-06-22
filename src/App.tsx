import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  Circle,
  GripVertical,
  Pencil,
  Moon,
  Folder,
  FolderOpen,
  Maximize2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import "./App.css";
import { TerminalView } from "./components/TerminalView";
import {
  closeTerminal,
  checkExecutablePath,
  createTerminal,
  getHomeDir,
  getShellProfiles,
  loadAppState,
  onTerminalData,
  onTerminalExit,
  openPathInExplorer,
  pickProjectDirectory,
  saveAppState,
  resizeTerminal,
} from "./services/tauriApi";
import type {
  AppStateFile,
  AppTheme,
  Project,
  RuntimeTab,
  SavedTab,
  ShellProfile,
} from "./types";

const MAX_TERMINALS_PER_PROJECT = 5;
const DEFAULT_SIDEBAR_WIDTH = 172;
const MIN_SIDEBAR_WIDTH = 112;
const MAX_SIDEBAR_WIDTH = 220;
const MAX_TERMINAL_WRITE_CHARS_PER_FRAME = 256 * 1024;

type TerminalOutputQueue = {
  chunks: string[];
  length: number;
  index: number;
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pathBaseName(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}

function defaultState(shellProfiles: ShellProfile[] = []): AppStateFile {
  return {
    version: 1,
    projects: [],
    tabs: [],
    activeProjectId: null,
    activeTabByProject: {},
    shellProfiles,
    defaultShellProfileId:
      shellProfiles.find((item) => item.detected)?.id ?? "powershell",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    theme: "dark",
    rightClickPaste: false,
    copyOnSelect: false,
  };
}

function clampSidebarWidth(width: number) {
  return Math.round(
    Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)),
  );
}

function tabToSaved(tab: RuntimeTab): SavedTab {
  return {
    id: tab.id,
    projectId: tab.projectId,
    title: tab.title,
    shellProfileId: tab.shellProfileId,
    cwd: tab.cwd,
    createdAt: tab.createdAt,
  };
}

function iconForProfile(profile?: ShellProfile) {
  if (!profile) return <SquareTerminal size={15} />;
  if (profile.id === "git-bash") return <Circle size={13} />;
  if (profile.id === "cmd") return <Maximize2 size={14} />;
  return <SquareTerminal size={15} />;
}

function takeTerminalOutputBatch(queue: TerminalOutputQueue) {
  const batch: string[] = [];
  let batchLength = 0;

  while (queue.index < queue.chunks.length) {
    const chunk = queue.chunks[queue.index];
    if (
      batch.length > 0 &&
      batchLength + chunk.length > MAX_TERMINAL_WRITE_CHARS_PER_FRAME
    ) {
      break;
    }
    queue.index += 1;
    queue.length -= chunk.length;
    batch.push(chunk);
    batchLength += chunk.length;
    if (batchLength >= MAX_TERMINAL_WRITE_CHARS_PER_FRAME) {
      break;
    }
  }

  if (queue.index > 64 && queue.index > queue.chunks.length / 2) {
    queue.chunks = queue.chunks.slice(queue.index);
    queue.index = 0;
  }

  return batch.length === 1 ? batch[0] : batch.join("");
}

export default function App() {
  const [hydrated, setHydrated] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tabs, setTabs] = useState<RuntimeTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeTabByProject, setActiveTabByProject] = useState<
    Record<string, string>
  >({});
  const [shellProfiles, setShellProfiles] = useState<ShellProfile[]>([]);
  const [defaultShellProfileId, setDefaultShellProfileId] =
    useState("powershell");
  const [query, setQuery] = useState("");
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [rightClickPaste, setRightClickPaste] = useState(false);
  const [copyOnSelect, setCopyOnSelect] = useState(false);

  const terminalRefs = useRef(new Map<string, Terminal>());
  const fitAddonRefs = useRef(new Map<string, FitAddon>());
  const terminalOutputQueues = useRef(new Map<string, TerminalOutputQueue>());
  const terminalOutputFrame = useRef<number | null>(null);
  const terminalOutputActive = useRef(true);
  const terminalSizeRefs = useRef(new Map<string, string>());
  const startedTerminals = useRef(new Set<string>());
  const saveTimer = useRef<number | null>(null);
  const lastSavedSnapshot = useRef<string | null>(null);
  const tabsRef = useRef<RuntimeTab[]>([]);
  const shellProfilesRef = useRef<ShellProfile[]>([]);
  const topbarActionsRef = useRef<HTMLDivElement | null>(null);
  const tabActionsRef = useRef<HTMLDivElement | null>(null);
  const draggedProjectId = useRef<string | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(
    null,
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );

  const tabsForProject = useMemo(
    () => tabs.filter((tab) => tab.projectId === activeProjectId),
    [activeProjectId, tabs],
  );

  const tabCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      counts.set(tab.projectId, (counts.get(tab.projectId) ?? 0) + 1);
    }
    return counts;
  }, [tabs]);

  const shellProfileById = useMemo(() => {
    return new Map(shellProfiles.map((profile) => [profile.id, profile]));
  }, [shellProfiles]);

  const activeTabId = activeProjectId
    ? activeTabByProject[activeProjectId] ?? tabsForProject[0]?.id
    : undefined;
  const activeTab = tabsForProject.find((tab) => tab.id === activeTabId) ?? null;

  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(keyword) ||
        project.path.toLowerCase().includes(keyword),
    );
  }, [projects, query]);

  const detectedProfiles = useMemo(
    () => shellProfiles.filter((profile) => profile.detected),
    [shellProfiles],
  );
  const projectSortingEnabled = query.trim().length === 0;

  const stateSnapshot = useCallback((): AppStateFile => {
    return {
      version: 1,
      projects,
      tabs: tabs.map(tabToSaved),
      activeProjectId,
      activeTabByProject,
      shellProfiles,
      defaultShellProfileId,
      sidebarWidth: Math.round(sidebarWidth),
      theme,
      rightClickPaste,
      copyOnSelect,
    };
  }, [
    activeProjectId,
    activeTabByProject,
    copyOnSelect,
    defaultShellProfileId,
    projects,
    rightClickPaste,
    sidebarWidth,
    shellProfiles,
    tabs,
    theme,
  ]);

  const scheduleSave = useCallback(() => {
    if (!hydrated) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      const snapshot = stateSnapshot();
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSavedSnapshot.current) return;
      void saveAppState(snapshot)
        .then(() => {
          lastSavedSnapshot.current = serialized;
        })
        .catch((saveError) => {
          setError(`保存会话失败: ${String(saveError)}`);
        });
    }, 350);
  }, [hydrated, stateSnapshot]);

  const startTerminal = useCallback(
    async (tab: RuntimeTab) => {
      if (startedTerminals.current.has(tab.id)) return;
      startedTerminals.current.add(tab.id);
      setTabs((current) =>
        current.map((item) =>
          item.id === tab.id ? { ...item, status: "starting", error: "" } : item,
        ),
      );

      try {
        const terminal = terminalRefs.current.get(tab.id);
        const shellProfile = shellProfilesRef.current.find(
          (profile) => profile.id === tab.shellProfileId,
        );
        const cols = terminal?.cols || 100;
        const rows = terminal?.rows || 30;
        await createTerminal({
          terminalId: tab.id,
          shellProfileId: tab.shellProfileId,
          shellProfile,
          cwd: tab.cwd,
          title: tab.title,
          cols,
          rows,
        });
        setTabs((current) =>
          current.map((item) =>
            item.id === tab.id ? { ...item, status: "running", error: "" } : item,
          ),
        );
      } catch (terminalError) {
        startedTerminals.current.delete(tab.id);
        const message = String(terminalError);
        setTabs((current) =>
          current.map((item) =>
            item.id === tab.id
              ? { ...item, status: "error", error: message }
              : item,
          ),
        );
        terminalRefs.current
          .get(tab.id)
          ?.writeln(`\r\n[mutishell] 启动失败: ${message}`);
      }
    },
    [],
  );

  const createTab = useCallback(
    (project: Project, profile: ShellProfile) => {
      const projectTabs = tabs.filter((tab) => tab.projectId === project.id);
      if (projectTabs.length >= MAX_TERMINALS_PER_PROJECT) {
        setError(`每个项目最多打开 ${MAX_TERMINALS_PER_PROJECT} 个终端`);
        setNewTerminalOpen(false);
        return;
      }

      const createdAt = nowIso();
      const id = makeId("tab");
      const sameProfileCount =
        projectTabs.filter((tab) => tab.shellProfileId === profile.id).length + 1;
      const title =
        sameProfileCount > 1 ? `${profile.name} ${sameProfileCount}` : profile.name;

      const tab: RuntimeTab = {
        id,
        projectId: project.id,
        title,
        shellProfileId: profile.id,
        cwd: project.path,
        createdAt,
        status: "idle",
      };
      setTabs((current) => [...current, tab]);
      setActiveTabByProject((current) => ({ ...current, [project.id]: id }));
      setNewTerminalOpen(false);
      window.setTimeout(() => void startTerminal(tab), 50);
    },
    [startTerminal, tabs],
  );

  const addProject = useCallback(async () => {
    const path = await pickProjectDirectory();
    if (!path) return;
    const existing = projects.find(
      (project) => project.path.toLowerCase() === path.toLowerCase(),
    );
    if (existing) {
      setActiveProjectId(existing.id);
      return;
    }

    const createdAt = nowIso();
    const project: Project = {
      id: makeId("project"),
      name: pathBaseName(path),
      path,
      createdAt,
      lastOpenedAt: createdAt,
    };
    setProjects((current) => [...current, project]);
    setActiveProjectId(project.id);

    const profile =
      detectedProfiles.find((item) => item.id === defaultShellProfileId) ??
      detectedProfiles[0] ??
      shellProfiles[0];
    if (profile) {
      window.setTimeout(() => createTab(project, profile), 80);
    }
  }, [
    createTab,
    defaultShellProfileId,
    detectedProfiles,
    projects,
    shellProfiles,
  ]);

  const removeProject = useCallback(
    (projectId: string) => {
      const projectTabs = tabs.filter((tab) => tab.projectId === projectId);
      for (const tab of projectTabs) {
        startedTerminals.current.delete(tab.id);
        void closeTerminal(tab.id);
      }
      setTabs((current) => current.filter((tab) => tab.projectId !== projectId));
      setProjects((current) =>
        current.filter((project) => project.id !== projectId),
      );
      setActiveTabByProject((current) => {
        const next = { ...current };
        delete next[projectId];
        return next;
      });
      if (activeProjectId === projectId) {
        const nextProject = projects.find((project) => project.id !== projectId);
        setActiveProjectId(nextProject?.id ?? null);
      }
    },
    [activeProjectId, projects, tabs],
  );

  const moveProject = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setProjects((current) => {
      const sourceIndex = current.findIndex((project) => project.id === sourceId);
      const targetIndex = current.findIndex((project) => project.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [source] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, source);
      return next;
    });
  }, []);

  const startProjectSort = useCallback(
    (
      event: React.PointerEvent<HTMLSpanElement>,
      projectId: string,
    ) => {
      if (!projectSortingEnabled || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      draggedProjectId.current = projectId;
      setDraggingProjectId(projectId);

      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Some WebView edge cases do not support capture on this element.
      }

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const sourceId = draggedProjectId.current;
        if (!sourceId) return;

        const element = document.elementFromPoint(
          moveEvent.clientX,
          moveEvent.clientY,
        );
        const projectElement = element?.closest("[data-project-id]") as
          | HTMLElement
          | null;
        const targetId = projectElement?.dataset.projectId;
        if (!targetId || targetId === sourceId) return;
        moveProject(sourceId, targetId);
      };

      const finishSort = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishSort);
        window.removeEventListener("pointercancel", finishSort);
        draggedProjectId.current = null;
        setDraggingProjectId(null);
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // Capture may already be released by the WebView.
        }
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishSort, { once: true });
      window.addEventListener("pointercancel", finishSort, { once: true });
    },
    [moveProject, projectSortingEnabled],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const closingTab = tabs.find((tab) => tab.id === tabId);
      if (!closingTab) return;
      startedTerminals.current.delete(tabId);
      void closeTerminal(tabId);
      setTabs((current) => current.filter((tab) => tab.id !== tabId));
      setActiveTabByProject((current) => {
        const projectTabs = tabs.filter(
          (tab) => tab.projectId === closingTab.projectId && tab.id !== tabId,
        );
        const next = { ...current };
        if (next[closingTab.projectId] === tabId) {
          if (projectTabs[0]) next[closingTab.projectId] = projectTabs[0].id;
          else delete next[closingTab.projectId];
        }
        return next;
      });
    },
    [tabs],
  );

  const restartTab = useCallback(
    async (tab: RuntimeTab) => {
      startedTerminals.current.delete(tab.id);
      await closeTerminal(tab.id).catch(() => undefined);
      terminalRefs.current.get(tab.id)?.reset();
      void startTerminal({ ...tab, status: "idle" });
    },
    [startTerminal],
  );

  const handleTerminalWriteError = useCallback(
    (terminalId: string, writeError: unknown) => {
      startedTerminals.current.delete(terminalId);
      void closeTerminal(terminalId).catch(() => undefined);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === terminalId && tab.status !== "error"
            ? {
                ...tab,
                status: "exited",
                error: `终端输入已停止: ${String(writeError)}`,
              }
            : tab,
        ),
      );
    },
    [],
  );

  const renameActiveTab = useCallback(() => {
    if (!activeTab) return;
    const title = window.prompt("重命名终端 Tab", activeTab.title)?.trim();
    if (!title) return;
    setTabs((current) =>
      current.map((tab) => (tab.id === activeTab.id ? { ...tab, title } : tab)),
    );
  }, [activeTab]);

  const ensureTerminalStarted = useCallback(
    (terminalId: string) => {
      const tab = tabsRef.current.find((item) => item.id === terminalId);
      if (
        tab?.status === "idle" &&
        terminalRefs.current.has(terminalId) &&
        !startedTerminals.current.has(terminalId)
      ) {
        void startTerminal(tab);
      }
    },
    [startTerminal],
  );

  const registerTerminal = useCallback(
    (terminalId: string, terminal: Terminal, fitAddon: FitAddon) => {
      terminalRefs.current.set(terminalId, terminal);
      fitAddonRefs.current.set(terminalId, fitAddon);
      ensureTerminalStarted(terminalId);
      window.setTimeout(() => ensureTerminalStarted(terminalId), 0);
    },
    [ensureTerminalStarted],
  );

  const unregisterTerminal = useCallback((terminalId: string) => {
    terminalRefs.current.delete(terminalId);
    fitAddonRefs.current.delete(terminalId);
    terminalOutputQueues.current.delete(terminalId);
    terminalSizeRefs.current.delete(terminalId);
  }, []);

  const resizeTerminalIfChanged = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      const sizeKey = `${cols}x${rows}`;
      if (terminalSizeRefs.current.get(terminalId) === sizeKey) return;
      terminalSizeRefs.current.set(terminalId, sizeKey);
      void resizeTerminal(terminalId, cols, rows);
    },
    [],
  );

  const flushTerminalOutput = useCallback(() => {
    terminalOutputFrame.current = null;
    let hasMoreOutput = false;
    for (const [terminalId, queue] of terminalOutputQueues.current) {
      const data = takeTerminalOutputBatch(queue);
      if (queue.length === 0) {
        terminalOutputQueues.current.delete(terminalId);
      } else {
        hasMoreOutput = true;
      }
      if (data.length === 0) continue;
      terminalRefs.current.get(terminalId)?.write(data);
    }
    if (
      hasMoreOutput &&
      terminalOutputActive.current &&
      terminalOutputFrame.current === null
    ) {
      terminalOutputFrame.current =
        window.requestAnimationFrame(flushTerminalOutput);
    }
  }, []);

  const enqueueTerminalOutput = useCallback(
    (terminalId: string, data: string) => {
      if (data.length === 0) return;
      const queue = terminalOutputQueues.current.get(terminalId);
      if (queue) {
        queue.chunks.push(data);
        queue.length += data.length;
      } else {
        terminalOutputQueues.current.set(terminalId, {
          chunks: [data],
          length: data.length,
          index: 0,
        });
      }

      if (terminalOutputFrame.current === null) {
        terminalOutputFrame.current =
          window.requestAnimationFrame(flushTerminalOutput);
      }
    },
    [flushTerminalOutput],
  );

  const fitActiveTerminal = useCallback(() => {
    if (!activeTabId) return;
    const terminal = terminalRefs.current.get(activeTabId);
    const fitAddon = fitAddonRefs.current.get(activeTabId);
    if (!terminal || !fitAddon) return;

    const fit = () => {
      try {
        fitAddon.fit();
        terminal.focus();
        resizeTerminalIfChanged(activeTabId, terminal.cols, terminal.rows);
      } catch {
        // The terminal may not be visible yet.
      }
    };

    window.requestAnimationFrame(fit);
    window.setTimeout(fit, 60);
    window.setTimeout(fit, 180);
  }, [activeTabId, resizeTerminalIfChanged]);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      try {
        const [state, freshProfiles] = await Promise.all([
          loadAppState().catch(() => defaultState()),
          getShellProfiles(),
        ]);
        if (cancelled) return;
        const profiles = state.shellProfiles.length
          ? state.shellProfiles.map((profile) => {
              const fresh = freshProfiles.find((item) => item.id === profile.id);
              if (!fresh) return profile;
              if (
                profile.executable.trim().toLowerCase() !==
                fresh.executable.trim().toLowerCase()
              ) {
                return profile;
              }
              return { ...profile, detected: fresh.detected };
            })
          : freshProfiles;
        const restoredTabs: RuntimeTab[] = state.tabs.map((tab) => ({
          ...tab,
          status: "idle",
        }));
        const restoredTabIds = new Set(restoredTabs.map((tab) => tab.id));
        const restoredActiveTabs = Object.fromEntries(
          Object.entries(state.activeTabByProject ?? {}).filter(([, tabId]) =>
            restoredTabIds.has(tabId),
          ),
        );
        tabsRef.current = restoredTabs;
        shellProfilesRef.current = profiles;
        setShellProfiles(profiles);
        setDefaultShellProfileId(
          state.defaultShellProfileId ||
            profiles.find((profile) => profile.detected)?.id ||
            "powershell",
        );
        setProjects(state.projects);
        setTabs(restoredTabs);
        setActiveProjectId(
          state.activeProjectId ??
            state.projects[0]?.id ??
            null,
        );
        setActiveTabByProject(restoredActiveTabs);
        setSidebarWidth(
          clampSidebarWidth(state.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
        );
        setTheme(state.theme ?? "dark");
        setRightClickPaste(state.rightClickPaste ?? false);
        setCopyOnSelect(state.copyOnSelect ?? false);
        setHydrated(true);
      } catch (hydrateError) {
        const profiles = await getShellProfiles().catch(() => []);
        if (cancelled) return;
        setShellProfiles(profiles);
        setDefaultShellProfileId(
          profiles.find((profile) => profile.detected)?.id ?? "powershell",
        );
        setHydrated(true);
        setError(`加载配置失败: ${String(hydrateError)}`);
      }
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    shellProfilesRef.current = shellProfiles;
  }, [shellProfiles]);

  useEffect(() => {
    if (!hydrated || shellProfiles.length === 0) return;
    for (const tab of tabs) {
      if (
        tab.status === "idle" &&
        terminalRefs.current.has(tab.id) &&
        !startedTerminals.current.has(tab.id)
      ) {
        ensureTerminalStarted(tab.id);
      }
    }
  }, [ensureTerminalStarted, hydrated, shellProfiles.length, tabs]);

  useEffect(() => {
    if (!hydrated) return;
    scheduleSave();
  }, [
    activeProjectId,
    activeTabByProject,
    defaultShellProfileId,
    hydrated,
    projects,
    scheduleSave,
    sidebarWidth,
    shellProfiles,
    tabs,
    theme,
  ]);

  const beginSidebarResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [sidebarWidth],
  );

  useEffect(() => {
    if (!newTerminalOpen) return;

    const closeTerminalMenu = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (topbarActionsRef.current?.contains(target)) return;
      if (tabActionsRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest("[data-new-terminal-control]")
      ) {
        return;
      }
      setNewTerminalOpen(false);
    };

    window.addEventListener("pointerdown", closeTerminalMenu, true);
    return () => {
      window.removeEventListener("pointerdown", closeTerminalMenu, true);
    };
  }, [newTerminalOpen]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void onTerminalData(({ terminalId, data }) => {
      enqueueTerminalOutput(terminalId, data);
    }).then((unlisten) => unlisteners.push(unlisten));

    void onTerminalExit(({ terminalId }) => {
      startedTerminals.current.delete(terminalId);
      void closeTerminal(terminalId).catch(() => undefined);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === terminalId && tab.status !== "error"
            ? { ...tab, status: "exited" }
            : tab,
        ),
      );
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      terminalOutputActive.current = false;
      for (const unlisten of unlisteners) unlisten();
      if (terminalOutputFrame.current !== null) {
        window.cancelAnimationFrame(terminalOutputFrame.current);
        flushTerminalOutput();
      }
    };
  }, [enqueueTerminalOutput, flushTerminalOutput]);

  useEffect(() => {
    const onBeforeUnload = () => {
      void saveAppState(stateSnapshot());
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [stateSnapshot]);

  useEffect(() => {
    if (!activeProjectId) return;
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProjectId
          ? { ...project, lastOpenedAt: nowIso() }
          : project,
      ),
    );
  }, [activeProjectId]);

  useEffect(() => {
    fitActiveTerminal();
  }, [activeProjectId, activeTabId, fitActiveTerminal, sidebarWidth]);

  if (!hydrated) {
    return (
      <main className="boot-screen">
        <SquareTerminal size={32} />
        <span>正在启动 mutishell...</span>
      </main>
    );
  }

  return (
    <main
      className="app-shell"
      data-theme={theme}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <SquareTerminal size={22} />
            <div>
              <strong>mutishell</strong>
            </div>
          </div>
        </div>

        <div className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目"
          />
        </div>

        <button className="add-project" onClick={addProject} type="button">
          <Plus size={16} />
          添加目录
        </button>

        <div className="project-list">
          <div className="section-label">项目</div>
          {filteredProjects.length === 0 ? (
            <div className="empty-side">
              <Folder size={18} />
              <span>还没有项目目录</span>
            </div>
          ) : (
            filteredProjects.map((project) => {
              const active = project.id === activeProjectId;
              const count = tabCountByProject.get(project.id) ?? 0;
              return (
                <div
                  className={[
                    "project-item",
                    active ? "active" : "",
                    draggingProjectId === project.id ? "sorting" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-project-id={project.id}
                  key={project.id}
                  onClick={() => setActiveProjectId(project.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setActiveProjectId(project.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title={project.path}
                >
                  {active ? <FolderOpen size={17} /> : <Folder size={17} />}
                  <span className="project-name">{project.name}</span>
                  {count > 0 && <em>{count}</em>}
                  <span
                    className="project-drag-handle"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) =>
                      startProjectSort(event, project.id)
                    }
                    title={
                      projectSortingEnabled
                        ? "按住拖动排序"
                        : "清空搜索后可排序"
                    }
                  >
                    <GripVertical size={15} />
                  </span>
                </div>
              );
            })
          )}
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        onPointerDown={beginSidebarResize}
        role="separator"
        title="拖动调整侧栏宽度"
      />

      <section className="workspace">
        <header className="topbar">
          <div className="project-title">
            <strong>{activeProject?.name ?? "选择一个目录"}</strong>
            <span>{activeProject?.path ?? "添加项目后即可在该目录打开终端"}</span>
          </div>
          <div className="topbar-actions" ref={topbarActionsRef}>
            <button
              className="icon-button"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              type="button"
            >
              <Settings size={17} />
            </button>
            <button
              className="icon-button"
              onClick={() =>
                setTheme((current) => (current === "dark" ? "light" : "dark"))
              }
              title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
              type="button"
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {activeProject && (
              <button
                className="ghost-button"
                onClick={() => void openPathInExplorer(activeProject.path)}
                title="打开资源管理器"
                type="button"
              >
                <FolderOpen size={16} />
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="error-bar">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              <X size={14} />
            </button>
          </div>
        )}

        {activeProject ? (
          <div className="terminal-area">
            <div className="tab-strip">
              <div className="terminal-count">
                {tabsForProject.length}/{MAX_TERMINALS_PER_PROJECT}
              </div>
              <div className="tabs">
                {tabsForProject.map((tab) => {
                  const profile = shellProfileById.get(tab.shellProfileId);
                  return (
                    <div
                      className={tab.id === activeTabId ? "tab active" : "tab"}
                      key={tab.id}
                      onClick={() =>
                        setActiveTabByProject((current) => ({
                          ...current,
                          [tab.projectId]: tab.id,
                        }))
                      }
                      onDoubleClick={renameActiveTab}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setActiveTabByProject((current) => ({
                            ...current,
                            [tab.projectId]: tab.id,
                          }));
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {iconForProfile(profile)}
                      <span>{tab.title}</span>
                      <i className={`status-dot ${tab.status}`} />
                      <button
                        className="tab-close"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                        title="关闭终端"
                        type="button"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
              {activeTab && (
                <div className="tab-actions" ref={tabActionsRef}>
                  <button
                    className="icon-button"
                    onClick={renameActiveTab}
                    title="重命名当前 Tab"
                    type="button"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => void restartTab(activeTab)}
                    title="重启当前终端"
                    type="button"
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    className="icon-button compact-add"
                    data-new-terminal-control
                    disabled={tabsForProject.length >= MAX_TERMINALS_PER_PROJECT}
                    onClick={() => setNewTerminalOpen((current) => !current)}
                    title={
                      tabsForProject.length >= MAX_TERMINALS_PER_PROJECT
                        ? `每个项目最多 ${MAX_TERMINALS_PER_PROJECT} 个终端`
                        : "新增终端"
                    }
                    type="button"
                  >
                    <Plus size={15} />
                  </button>
                  {newTerminalOpen && activeProject && (
                    <div className="terminal-menu tab-terminal-menu">
                      {shellProfiles.map((profile) => (
                        <button
                          disabled={
                            !profile.detected ||
                            tabsForProject.length >= MAX_TERMINALS_PER_PROJECT
                          }
                          key={profile.id}
                          onClick={() => createTab(activeProject, profile)}
                          type="button"
                        >
                          {iconForProfile(profile)}
                          <span>{profile.name}</span>
                          {!profile.detected && <em>未检测到</em>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="terminal-stack">
              {tabs.map((tab) => (
                <TerminalView
                  active={tab.id === activeTabId && tab.projectId === activeProjectId}
                  copyOnSelect={copyOnSelect}
                  key={tab.id}
                  onDispose={unregisterTerminal}
                  onReady={registerTerminal}
                  onResize={resizeTerminalIfChanged}
                  onWriteError={handleTerminalWriteError}
                  rightClickPaste={rightClickPaste}
                  tab={tab}
                />
              ))}
              {tabsForProject.length === 0 && (
                <div className="empty-workspace">
                  <SquareTerminal size={42} />
                  <strong>在 {activeProject.name} 打开一个终端</strong>
                  <span>{activeProject.path}</span>
                  <div className="quick-profiles">
                    {(detectedProfiles.length ? detectedProfiles : shellProfiles).map(
                      (profile) => (
                        <button
                          disabled={
                            !profile.detected ||
                            tabsForProject.length >= MAX_TERMINALS_PER_PROJECT
                          }
                          key={profile.id}
                          onClick={() => createTab(activeProject, profile)}
                          type="button"
                        >
                          {iconForProfile(profile)}
                          {profile.name}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}
              {activeTab?.status === "error" && (
                <div className="terminal-overlay">
                  <strong>终端启动失败</strong>
                  <span>{activeTab.error}</span>
                  <button
                    onClick={() => void restartTab(activeTab)}
                    type="button"
                  >
                    <RefreshCw size={15} />
                    重试
                  </button>
                </div>
              )}
              {activeTab?.status === "starting" && (
                <div className="terminal-overlay subtle">
                  <strong>正在恢复终端...</strong>
                  <span>{activeTab.title}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="welcome">
            <FolderOpen size={50} />
            <h1>添加一个项目目录</h1>
            <p>mutishell 会记住每个目录打开过的终端，下次启动自动恢复。</p>
            <button className="primary-button" onClick={addProject} type="button">
              <Plus size={17} />
              选择目录
            </button>
          </div>
        )}
      </section>

      {settingsOpen && (
        <SettingsDialog
          defaultShellProfileId={defaultShellProfileId}
          copyOnSelect={copyOnSelect}
          onClose={() => setSettingsOpen(false)}
          onCopyOnSelectChange={setCopyOnSelect}
          onDefaultChange={setDefaultShellProfileId}
          onProfilesChange={setShellProfiles}
          onRemoveProject={removeProject}
          onRightClickPasteChange={setRightClickPaste}
          projects={projects}
          rightClickPaste={rightClickPaste}
          shellProfiles={shellProfiles}
        />
      )}
    </main>
  );
}

type SettingsDialogProps = {
  shellProfiles: ShellProfile[];
  defaultShellProfileId: string;
  copyOnSelect: boolean;
  projects: Project[];
  onClose: () => void;
  onCopyOnSelectChange: (enabled: boolean) => void;
  onDefaultChange: (id: string) => void;
  onProfilesChange: (profiles: ShellProfile[]) => void;
  onRemoveProject: (projectId: string) => void;
  onRightClickPasteChange: (enabled: boolean) => void;
  rightClickPaste: boolean;
};

function SettingsDialog({
  shellProfiles,
  defaultShellProfileId,
  copyOnSelect,
  projects,
  onClose,
  onCopyOnSelectChange,
  onDefaultChange,
  onProfilesChange,
  onRemoveProject,
  onRightClickPasteChange,
  rightClickPaste,
}: SettingsDialogProps) {
  const [homeDir, setHomeDir] = useState("");
  const [defaultProfiles, setDefaultProfiles] = useState<ShellProfile[]>([]);
  const [draftProfiles, setDraftProfiles] = useState<ShellProfile[]>(shellProfiles);
  const [checkingProfileId, setCheckingProfileId] = useState<string | null>(null);

  useEffect(() => {
    void getHomeDir().then(setHomeDir).catch(() => undefined);
    void getShellProfiles().then(setDefaultProfiles).catch(() => undefined);
  }, []);

  useEffect(() => {
    setDraftProfiles(shellProfiles);
  }, [shellProfiles]);

  const updateProfilePath = (profileId: string, executable: string) => {
    setDraftProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId ? { ...profile, executable } : profile,
      ),
    );
  };

  const validateProfile = async (profileId: string) => {
    const profile = draftProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    setCheckingProfileId(profileId);
    const detected = await checkExecutablePath(profile.executable).catch(
      () => false,
    );
    setDraftProfiles((current) =>
      current.map((item) =>
        item.id === profileId ? { ...item, detected } : item,
      ),
    );
    setCheckingProfileId(null);
  };

  const restoreProfile = (profileId: string) => {
    const profile = defaultProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    setDraftProfiles((current) =>
      current.map((item) => (item.id === profileId ? profile : item)),
    );
  };

  const applySettings = () => {
    const nextProfiles = draftProfiles.map((profile) => ({
      ...profile,
      executable: profile.executable.trim(),
    }));
    onProfilesChange(nextProfiles);
    const defaultProfile = nextProfiles.find(
      (profile) => profile.id === defaultShellProfileId,
    );
    if (!defaultProfile?.detected) {
      onDefaultChange(
        nextProfiles.find((profile) => profile.detected)?.id ?? "powershell",
      );
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <strong>设置</strong>
            <span>Shell 检测、默认终端和项目管理</span>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </header>

        <div className="settings-grid">
          <section>
            <h2>Shell Profiles</h2>
            <div className="profile-list">
              {draftProfiles.map((profile) => (
                <div className="profile-row" key={profile.id}>
                  <input
                    checked={defaultShellProfileId === profile.id}
                    disabled={!profile.detected}
                    name="default-shell"
                    onChange={() => onDefaultChange(profile.id)}
                    type="radio"
                  />
                  <div>
                    <strong>{profile.name}</strong>
                    <input
                      className="path-input"
                      onChange={(event) =>
                        updateProfilePath(profile.id, event.target.value)
                      }
                      onBlur={() => void validateProfile(profile.id)}
                      value={profile.executable}
                    />
                    <div className="profile-tools">
                      <button
                        onClick={() => void validateProfile(profile.id)}
                        type="button"
                      >
                        {checkingProfileId === profile.id ? "检测中" : "检测"}
                      </button>
                      <button
                        disabled={
                          !defaultProfiles.some((item) => item.id === profile.id)
                        }
                        onClick={() => restoreProfile(profile.id)}
                        type="button"
                      >
                        恢复默认
                      </button>
                    </div>
                  </div>
                  <em className={profile.detected ? "ok" : "missing"}>
                    {profile.detected ? "可用" : "未找到"}
                  </em>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>项目目录</h2>
            <div className="managed-projects">
              {projects.length === 0 ? (
                <span className="muted">暂无项目。用户目录：{homeDir}</span>
              ) : (
                projects.map((project) => (
                  <div className="managed-project" key={project.id}>
                    <Folder size={16} />
                    <div>
                      <strong>{project.name}</strong>
                      <span>{project.path}</span>
                    </div>
                    <button
                      className="icon-button danger"
                      onClick={() => onRemoveProject(project.id)}
                      title="移除项目"
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          <section>
            <h2>终端行为</h2>
            <label className="setting-toggle">
              <input
                checked={copyOnSelect}
                onChange={(event) =>
                  onCopyOnSelectChange(event.target.checked)
                }
                type="checkbox"
              />
              <span>
                <strong>选中复制</strong>
                <em>鼠标选中终端文本后自动复制到系统剪贴板</em>
              </span>
            </label>
            <label className="setting-toggle">
              <input
                checked={rightClickPaste}
                onChange={(event) =>
                  onRightClickPasteChange(event.target.checked)
                }
                type="checkbox"
              />
              <span>
                <strong>右键粘贴</strong>
                <em>在终端区域右键时粘贴系统剪贴板文本</em>
              </span>
            </label>
          </section>
        </div>

        <footer>
          <button className="primary-button" onClick={applySettings} type="button">
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
