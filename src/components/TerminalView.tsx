import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { saveSystemClipboardFiles, writeTerminal } from "../services/tauriApi";
import type { RuntimeTab } from "../types";
import { formatTerminalPaths } from "../utils/terminalPaths";

type TerminalViewProps = {
  tab: RuntimeTab;
  active: boolean;
  rightClickPaste: boolean;
  copyOnSelect: boolean;
  onInputError: (message: string) => void;
  onWriteError: (terminalId: string, error: unknown) => void;
  onReady: (terminalId: string, terminal: Terminal, fitAddon: FitAddon) => void;
  onDispose: (terminalId: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
};

function TerminalViewComponent({
  tab,
  active,
  rightClickPaste,
  copyOnSelect,
  onInputError,
  onWriteError,
  onReady,
  onDispose,
  onResize,
}: TerminalViewProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const outputDockAnchorRef = useRef<HTMLSpanElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const statusRef = useRef(tab.status);
  const rightClickPasteRef = useRef(rightClickPaste);
  const copyOnSelectRef = useRef(copyOnSelect);
  const refreshFrameRef = useRef<number | null>(null);
  const refreshTimeoutRef = useRef<number | null>(null);
  const outputSettledTimeoutRef = useRef<number | null>(null);
  const tuiSequenceWindowRef = useRef({ count: 0, startedAt: 0 });
  const lastFitSizeRef = useRef("");

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    statusRef.current = tab.status;
  }, [tab.status]);

  useEffect(() => {
    rightClickPasteRef.current = rightClickPaste;
  }, [rightClickPaste]);

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect;
  }, [copyOnSelect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily:
        "Cascadia Mono, CaskaydiaCove Nerd Font, Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.16,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      scrollback: 8000,
      tabStopWidth: 4,
      windowsPty: {
        backend: "conpty",
      },
      theme: {
        background: "#111318",
        foreground: "#d8dee9",
        cursor: "#a6e3a1",
        selectionBackground: "#3b4252",
        black: "#2e3440",
        red: "#bf616a",
        green: "#a3be8c",
        yellow: "#ebcb8b",
        blue: "#81a1c1",
        magenta: "#b48ead",
        cyan: "#88c0d0",
        white: "#e5e9f0",
        brightBlack: "#4c566a",
        brightRed: "#bf616a",
        brightGreen: "#a3be8c",
        brightYellow: "#ebcb8b",
        brightBlue: "#81a1c1",
        brightMagenta: "#b48ead",
        brightCyan: "#8fbcbb",
        brightWhite: "#eceff4",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const clearQueuedRefresh = () => {
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
    const refreshVisibleRows = (clearTexture = false) => {
      if (!activeRef.current) return;
      if (clearTexture) {
        terminal.clearTextureAtlas();
      }
      terminal.refresh(0, terminal.rows - 1);
    };
    const queueRefresh = (clearTexture = false) => {
      if (refreshFrameRef.current !== null) return;
      refreshFrameRef.current = window.requestAnimationFrame(() => {
        refreshFrameRef.current = null;
        refreshVisibleRows(clearTexture);

        if (refreshTimeoutRef.current !== null) {
          window.clearTimeout(refreshTimeoutRef.current);
        }
        refreshTimeoutRef.current = window.setTimeout(() => {
          refreshTimeoutRef.current = null;
          refreshVisibleRows(clearTexture);
        }, 80);
      });
    };
    const inputDisposable = terminal.onData((data) => {
      if (statusRef.current !== "running" && statusRef.current !== "starting") return;
      void writeTerminal(tab.id, data).catch((error) => onWriteError(tab.id, error));
    });
    const dockHelperTextarea = () => {
      const view = viewRef.current;
      const anchor = outputDockAnchorRef.current;
      if (!view || !anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      view.style.setProperty("--output-dock-left", `${anchorRect.left}px`);
      view.style.setProperty("--output-dock-top", `${anchorRect.top}px`);
      view.style.setProperty(
        "--output-dock-width",
        `${Math.max(anchorRect.width, 120)}px`,
      );
      view.style.setProperty(
        "--output-dock-height",
        `${Math.max(anchorRect.height, 16)}px`,
      );
    };
    const releaseHelperTextareaDock = () => {
      const view = viewRef.current;
      if (!view) return;
      view.style.removeProperty("--output-dock-left");
      view.style.removeProperty("--output-dock-top");
      view.style.removeProperty("--output-dock-width");
      view.style.removeProperty("--output-dock-height");
    };
    const hideCursorDuringOutput = () => {
      viewRef.current?.classList.add("is-outputting");
      if (outputSettledTimeoutRef.current !== null) {
        window.clearTimeout(outputSettledTimeoutRef.current);
      }
      outputSettledTimeoutRef.current = window.setTimeout(() => {
        outputSettledTimeoutRef.current = null;
        viewRef.current?.classList.remove("is-outputting");
      }, 160);
    };
    const paramsInclude = (
      params: (number | number[])[],
      values: ReadonlySet<number>,
    ) =>
      params.some((param) =>
        Array.isArray(param)
          ? param.some((value) => values.has(value))
          : values.has(param),
      );
    const noteTuiSequence = (threshold = 4) => {
      const now = performance.now();
      const windowState = tuiSequenceWindowRef.current;
      if (now - windowState.startedAt > 80) {
        windowState.startedAt = now;
        windowState.count = 0;
      }
      windowState.count += 1;
      if (windowState.count >= threshold) {
        hideCursorDuringOutput();
      }
    };
    const handlePrivateMode = (params: (number | number[])[]) => {
      if (paramsInclude(params, new Set([25, 2026, 1047, 1048, 1049]))) {
        hideCursorDuringOutput();
      }
      return false;
    };
    const handleCursorPosition = (params: (number | number[])[]) => {
      void params;
      noteTuiSequence();
      return false;
    };
    const handleErase = (params: (number | number[])[]) => {
      void params;
      noteTuiSequence(3);
      return false;
    };
    const writeParsedDisposable = terminal.onWriteParsed(() => {
      hideCursorDuringOutput();
    });
    const showCursorModeDisposable = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      handlePrivateMode,
    );
    const hideCursorModeDisposable = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      handlePrivateMode,
    );
    const cursorPositionDisposable = terminal.parser.registerCsiHandler(
      { final: "H" },
      handleCursorPosition,
    );
    const cursorPositionAltDisposable = terminal.parser.registerCsiHandler(
      { final: "f" },
      handleCursorPosition,
    );
    const eraseDisplayDisposable = terminal.parser.registerCsiHandler(
      { final: "J" },
      handleErase,
    );
    const eraseLineDisposable = terminal.parser.registerCsiHandler(
      { final: "K" },
      handleErase,
    );
    const handleWheel = () => {
      queueRefresh();
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (!rightClickPasteRef.current || !activeRef.current) return;
      if (statusRef.current !== "running" && statusRef.current !== "starting") return;
      event.preventDefault();
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text.length > 0) {
            return writeTerminal(tab.id, text);
          }
        })
        .catch(() => undefined);
    };
    const copySelection = () => {
      if (!copyOnSelectRef.current || !activeRef.current) return;
      const selection = terminal.getSelection();
      if (selection.length > 0) {
        void navigator.clipboard?.writeText(selection).catch(() => undefined);
      }
    };
    const handlePointerUp = () => {
      window.setTimeout(copySelection, 0);
    };
    const insertPaths = (paths: string[]) => {
      const { text } = formatTerminalPaths(paths, tab.shellProfileId);
      if (!text) return;
      terminal.focus();
      void writeTerminal(tab.id, text).catch((error) =>
        onWriteError(tab.id, error),
      );
    };
    const handlePaste = (event: ClipboardEvent) => {
      if (!activeRef.current) return;
      if (statusRef.current !== "running" && statusRef.current !== "starting") {
        return;
      }

      const types = Array.from(event.clipboardData?.types ?? []);
      const hasTextData = types.some((type) =>
        ["text/plain", "text/html", "text/uri-list"].includes(type),
      );
      if (hasTextData) return;

      event.preventDefault();
      void saveSystemClipboardFiles()
        .then(insertPaths)
        .catch((error) => onInputError(`粘贴文件失败: ${String(error)}`));
    };
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("contextmenu", handleContextMenu);
    container.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("paste", handlePaste, true);

    const fit = () => {
      try {
        if (container.clientWidth < 40 || container.clientHeight < 40) return;
        const previousSize = `${terminal.cols}x${terminal.rows}`;
        fitAddon.fit();
        const nextSize = `${terminal.cols}x${terminal.rows}`;
        const sizeChanged = previousSize !== nextSize || lastFitSizeRef.current !== nextSize;
        lastFitSizeRef.current = nextSize;
        dockHelperTextarea();
        queueRefresh(sizeChanged);
        onResize(tab.id, terminal.cols, terminal.rows);
      } catch {
        // xterm can throw if the element is detached during fast tab switching.
      }
    };
    let fitFrame: number | null = null;
    const queueFit = () => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        fit();
      });
    };

    const resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(container);
    dockHelperTextarea();
    queueFit();
    onReady(tab.id, terminal, fitAddon);

    return () => {
      inputDisposable.dispose();
      writeParsedDisposable.dispose();
      showCursorModeDisposable.dispose();
      hideCursorModeDisposable.dispose();
      cursorPositionDisposable.dispose();
      cursorPositionAltDisposable.dispose();
      eraseDisplayDisposable.dispose();
      eraseLineDisposable.dispose();
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("paste", handlePaste, true);
      clearQueuedRefresh();
      if (outputSettledTimeoutRef.current !== null) {
        window.clearTimeout(outputSettledTimeoutRef.current);
        outputSettledTimeoutRef.current = null;
      }
      viewRef.current?.classList.remove("is-outputting");
      releaseHelperTextareaDock();
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
      resizeObserver.disconnect();
      onDispose(tab.id);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onDispose, onReady, onResize, tab.id]);

  useEffect(() => {
    if (!active || !fitAddonRef.current || !terminalRef.current) {
      return;
    }

    const fit = () => {
      try {
        if (!activeRef.current) return;
        const fitAddon = fitAddonRef.current;
        const terminal = terminalRef.current;
        const container = containerRef.current;
        if (
          !fitAddon ||
          !terminal ||
          !container ||
          container.clientWidth < 40 ||
          container.clientHeight < 40
        ) {
          return;
        }
        fitAddon.fit();
        terminal.focus();
        const anchor = outputDockAnchorRef.current;
        if (anchor) {
          const anchorRect = anchor.getBoundingClientRect();
          viewRef.current?.style.setProperty(
            "--output-dock-left",
            `${anchorRect.left}px`,
          );
          viewRef.current?.style.setProperty(
            "--output-dock-top",
            `${anchorRect.top}px`,
          );
          viewRef.current?.style.setProperty(
            "--output-dock-width",
            `${Math.max(anchorRect.width, 120)}px`,
          );
          viewRef.current?.style.setProperty(
            "--output-dock-height",
            `${Math.max(anchorRect.height, 16)}px`,
          );
        }
        onResize(tab.id, terminal.cols, terminal.rows);
      } catch {
        // Ignore transient layout reads while React is switching views.
      }
    };

    const frameId = window.requestAnimationFrame(fit);
    const timeoutIds = [window.setTimeout(fit, 60), window.setTimeout(fit, 180)];
    return () => {
      window.cancelAnimationFrame(frameId);
      timeoutIds.forEach((id) => window.clearTimeout(id));
    };
  }, [active, onResize, tab.id]);

  return (
    <div
      className={["terminal-view", "is-ime-docked", active ? "is-active" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={!active}
      ref={viewRef}
    >
      <div className="terminal-mount" ref={containerRef} />
      <div className="terminal-output-dock" aria-hidden="true">
        <span className="terminal-output-dock-anchor" ref={outputDockAnchorRef} />
      </div>
    </div>
  );
}

export const TerminalView = memo(
  TerminalViewComponent,
  (previous, next) =>
    previous.tab.id === next.tab.id &&
    previous.active === next.active &&
    previous.tab.status === next.tab.status &&
    previous.tab.shellProfileId === next.tab.shellProfileId &&
    previous.rightClickPaste === next.rightClickPaste &&
    previous.copyOnSelect === next.copyOnSelect &&
    previous.onInputError === next.onInputError &&
    previous.onWriteError === next.onWriteError,
);
