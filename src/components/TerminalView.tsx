import { memo, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { writeTerminal } from "../services/tauriApi";
import type { AppTheme, RuntimeTab } from "../types";
import { pasteManager } from "../utils/pasteManager";

type TerminalViewProps = {
  tab: RuntimeTab;
  active: boolean;
  copyOnSelect: boolean;
  terminalFontSize: number;
  theme: AppTheme;
  onInputError: (message: string) => void;
  onWriteError: (terminalId: string, error: unknown) => void;
  onReady: (terminalId: string, terminal: Terminal, requestFit: () => void) => void;
  onDispose: (terminalId: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
  onCompositionChange: (terminalId: string, composing: boolean) => void;
};

const ALT_ENTER_SEQUENCE = "\x1b\r";

function toHexColor(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function makeLightExtendedAnsiPalette() {
  const colors: string[] = [];
  const cube = [0, 95, 135, 175, 215, 255];

  for (let redIndex = 0; redIndex < 6; redIndex += 1) {
    for (let greenIndex = 0; greenIndex < 6; greenIndex += 1) {
      for (let blueIndex = 0; blueIndex < 6; blueIndex += 1) {
        const red = cube[redIndex];
        const green = cube[greenIndex];
        const blue = cube[blueIndex];
        const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        colors.push(
          luminance < 48
            ? "#edf4f7"
            : luminance < 72
              ? "#e5eef3"
              : toHexColor(red, green, blue),
        );
      }
    }
  }

  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    colors.push(value < 88 ? "#edf4f7" : toHexColor(value, value, value));
  }

  return colors;
}

const LIGHT_EXTENDED_ANSI = makeLightExtendedAnsiPalette();

const TERMINAL_THEMES: Record<AppTheme, ITheme> = {
  dark: {
    background: "#111318",
    foreground: "#d8dee9",
    cursor: "#a6e3a1",
    cursorAccent: "#111318",
    selectionBackground: "#3b4252",
    selectionForeground: "#f4f7fb",
    selectionInactiveBackground: "#2f3946",
    scrollbarSliderBackground: "#3a4652",
    scrollbarSliderHoverBackground: "#4b5967",
    scrollbarSliderActiveBackground: "#5d6c7b",
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
  light: {
    background: "#fbfdff",
    foreground: "#24313b",
    cursor: "#1d6f87",
    cursorAccent: "#fbfdff",
    selectionBackground: "#cfe8ef",
    selectionForeground: "#15232c",
    selectionInactiveBackground: "#dce9ee",
    scrollbarSliderBackground: "#b7c7d2",
    scrollbarSliderHoverBackground: "#9badb9",
    scrollbarSliderActiveBackground: "#8298a6",
    black: "#edf4f7",
    red: "#b42318",
    green: "#1f7a4d",
    yellow: "#8a5a00",
    blue: "#1d5f99",
    magenta: "#8b4a8f",
    cyan: "#187180",
    white: "#f8fbfc",
    brightBlack: "#c7d6de",
    brightRed: "#d14536",
    brightGreen: "#239b56",
    brightYellow: "#b7791f",
    brightBlue: "#2f80c4",
    brightMagenta: "#a765ad",
    brightCyan: "#2495a5",
    brightWhite: "#ffffff",
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
};

function TerminalViewComponent({
  tab,
  active,
  copyOnSelect,
  terminalFontSize,
  theme,
  onInputError,
  onWriteError,
  onReady,
  onDispose,
  onResize,
  onCompositionChange,
}: TerminalViewProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    canCopy: boolean;
    canPaste: boolean;
  } | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const contextMenuActionsRef = useRef<{
    copy: () => Promise<void>;
    paste: () => Promise<void>;
  } | null>(null);
  const activeRef = useRef(active);
  const statusRef = useRef(tab.status);
  const copyOnSelectRef = useRef(copyOnSelect);
  const composingRef = useRef(false);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const refreshFrameRef = useRef<number | null>(null);
  const refreshTimeoutRef = useRef<number | null>(null);
  const outputSettledTimeoutRef = useRef<number | null>(null);
  const lastFitSizeRef = useRef("");
  const suppressNextPasteEventRef = useRef(false);
  const pendingFitRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const pendingTextureRefreshRef = useRef(false);
  const requestFitRef = useRef<((clearTexture?: boolean) => void) | null>(null);
  const requestRefreshRef = useRef<
    ((clearTexture?: boolean) => void) | null
  >(null);
  const pendingFontSizeRef = useRef<number | null>(null);
  const pendingThemeRef = useRef<AppTheme | null>(null);
  const compositionEpochRef = useRef(0);
  const compositionReleaseTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    statusRef.current = tab.status;
  }, [tab.status]);

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect;
  }, [copyOnSelect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    composingRef.current = false;
    pendingFitRef.current = false;
    pendingRefreshRef.current = false;
    pendingTextureRefreshRef.current = false;
    pendingFontSizeRef.current = null;
    pendingThemeRef.current = null;
    compositionEpochRef.current = 0;
    compositionReleaseTimeoutRef.current = null;
    lastFitSizeRef.current = "";

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily:
        "Cascadia Mono, CaskaydiaCove Nerd Font, Consolas, 'Courier New', monospace",
      fontSize: terminalFontSize,
      lineHeight: 1.16,
      minimumContrastRatio: 4.5,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      scrollback: 8000,
      tabStopWidth: 4,
      windowsPty: {
        backend: "conpty",
      },
      theme: TERMINAL_THEMES[theme],
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;

    let queuedRefreshClearsTexture = false;
    const deferRefresh = (clearTexture = false) => {
      pendingRefreshRef.current = true;
      pendingTextureRefreshRef.current ||= clearTexture;
    };
    const clearQueuedRefresh = (defer = false) => {
      if (
        defer &&
        (refreshFrameRef.current !== null || refreshTimeoutRef.current !== null)
      ) {
        deferRefresh(queuedRefreshClearsTexture);
      }
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
      queuedRefreshClearsTexture = false;
    };
    const refreshVisibleRows = (clearTexture = false) => {
      if (composingRef.current) {
        deferRefresh(clearTexture);
        return;
      }
      if (!activeRef.current) return;
      if (clearTexture) {
        terminal.clearTextureAtlas();
      }
      terminal.refresh(0, terminal.rows - 1);
    };
    const queueRefresh = (clearTexture = false) => {
      if (composingRef.current) {
        deferRefresh(clearTexture);
        return;
      }
      queuedRefreshClearsTexture ||= clearTexture;
      if (refreshFrameRef.current !== null) return;
      refreshFrameRef.current = window.requestAnimationFrame(() => {
        refreshFrameRef.current = null;
        const refreshClearsTexture = queuedRefreshClearsTexture;
        queuedRefreshClearsTexture = false;
        refreshVisibleRows(refreshClearsTexture);

        if (refreshTimeoutRef.current !== null) {
          window.clearTimeout(refreshTimeoutRef.current);
        }
        refreshTimeoutRef.current = window.setTimeout(() => {
          refreshTimeoutRef.current = null;
          refreshVisibleRows(refreshClearsTexture);
        }, 80);
      });
    };
    const writeTerminalInput = (data: string) => {
      if (statusRef.current !== "running" && statusRef.current !== "starting") return;
      void writeTerminal(tab.id, data).catch((error) => onWriteError(tab.id, error));
    };
    const inputDisposable = terminal.onData(writeTerminalInput);
    const hideCursorDuringOutput = () => {
      viewRef.current?.classList.add("is-outputting");
      if (outputSettledTimeoutRef.current !== null) {
        window.clearTimeout(outputSettledTimeoutRef.current);
      }
      outputSettledTimeoutRef.current = window.setTimeout(() => {
        outputSettledTimeoutRef.current = null;
        viewRef.current?.classList.remove("is-outputting");
      }, 64);
    };
    const writeParsedDisposable = terminal.onWriteParsed(() => {
      if (!composingRef.current) {
        hideCursorDuringOutput();
      }
    });
    const handleWheel = () => {
      setContextMenu(null);
      queueRefresh();
    };
    const pasteFromSystemClipboard = async (fallbackText = "") => {
      if (statusRef.current !== "running" && statusRef.current !== "starting") {
        return;
      }

      await pasteManager({
        fallbackText,
        onInputError,
        onWriteError,
        shellProfileId: tab.shellProfileId,
        terminal,
        terminalId: tab.id,
      });
    };
    const copyCurrentSelection = async () => {
      const selection = terminal.getSelection();
      if (selection.length > 0) {
        await navigator.clipboard?.writeText(selection);
      }
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (!activeRef.current) return;
      event.preventDefault();
      terminal.focus();
      setContextMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 132)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 76)),
        canCopy: terminal.getSelection().length > 0,
        canPaste:
          statusRef.current === "running" || statusRef.current === "starting",
      });
    };
    const copySelection = () => {
      if (!copyOnSelectRef.current || !activeRef.current) return;
      void copyCurrentSelection().catch(() => undefined);
    };
    const handlePointerUp = () => {
      window.setTimeout(copySelection, 0);
    };
    const handlePaste = (event: ClipboardEvent) => {
      if (!activeRef.current) return;
      if (statusRef.current !== "running" && statusRef.current !== "starting") {
        return;
      }
      if (suppressNextPasteEventRef.current) {
        suppressNextPasteEventRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      event.stopPropagation();
      void pasteFromSystemClipboard(text);
    };
    const handleTerminalKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) return;

      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.isComposing &&
        !composingRef.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        writeTerminalInput(ALT_ENTER_SEQUENCE);
        return;
      }

      if (event.key.toLowerCase() !== "v" || event.altKey) return;
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      event.stopPropagation();
      suppressNextPasteEventRef.current = true;
      void pasteFromSystemClipboard();
      window.setTimeout(() => {
        suppressNextPasteEventRef.current = false;
      }, 120);
    };
    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        contextMenuRef.current?.contains(target)
      ) {
        return;
      }
      setContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    contextMenuActionsRef.current = {
      copy: copyCurrentSelection,
      paste: pasteFromSystemClipboard,
    };
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("contextmenu", handleContextMenu);
    container.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("keydown", handleTerminalKeyDown, true);
    container.addEventListener("paste", handlePaste, true);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    window.addEventListener("keydown", handleKeyDown);

    const deferFit = (clearTexture = false) => {
      pendingFitRef.current = true;
      pendingTextureRefreshRef.current ||= clearTexture;
    };
    const fit = (clearTexture = false) => {
      if (composingRef.current) {
        deferFit(clearTexture);
        return;
      }
      try {
        if (container.clientWidth < 40 || container.clientHeight < 40) return;
        const previousSize = `${terminal.cols}x${terminal.rows}`;
        fitAddon.fit();
        const nextSize = `${terminal.cols}x${terminal.rows}`;
        const sizeChanged =
          previousSize !== nextSize || lastFitSizeRef.current !== nextSize;
        lastFitSizeRef.current = nextSize;
        queueRefresh(clearTexture || sizeChanged);
        onResize(tab.id, terminal.cols, terminal.rows);
      } catch {
        // xterm can throw if the element is detached during fast tab switching.
      }
    };
    let fitFrame: number | null = null;
    let queuedFitClearsTexture = false;
    const queueFit = (clearTexture = false) => {
      if (composingRef.current) {
        deferFit(clearTexture);
        return;
      }
      queuedFitClearsTexture ||= clearTexture;
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        const fitClearsTexture = queuedFitClearsTexture;
        queuedFitClearsTexture = false;
        fit(fitClearsTexture);
      });
    };
    const cancelQueuedFit = () => {
      if (fitFrame === null) return;
      window.cancelAnimationFrame(fitFrame);
      fitFrame = null;
      deferFit(queuedFitClearsTexture);
      queuedFitClearsTexture = false;
    };
    const flushDeferredRendering = () => {
      if (pendingFontSizeRef.current !== null) {
        terminal.options.fontSize = pendingFontSizeRef.current;
        pendingFontSizeRef.current = null;
        pendingFitRef.current = true;
        pendingTextureRefreshRef.current = true;
      }
      if (pendingThemeRef.current !== null) {
        terminal.options.theme = { ...TERMINAL_THEMES[pendingThemeRef.current] };
        pendingThemeRef.current = null;
        pendingRefreshRef.current = true;
        pendingTextureRefreshRef.current = true;
      }

      const shouldFit = pendingFitRef.current;
      const shouldRefresh = pendingRefreshRef.current;
      const clearTexture = pendingTextureRefreshRef.current;
      pendingFitRef.current = false;
      pendingRefreshRef.current = false;
      pendingTextureRefreshRef.current = false;

      if (shouldFit) {
        queueFit(clearTexture);
      } else if (shouldRefresh) {
        queueRefresh(clearTexture);
      }
    };
    requestFitRef.current = queueFit;
    requestRefreshRef.current = queueRefresh;

    const releaseComposition = () => {
      if (compositionReleaseTimeoutRef.current !== null) {
        window.clearTimeout(compositionReleaseTimeoutRef.current);
        compositionReleaseTimeoutRef.current = null;
      }
      if (!composingRef.current) return;

      compositionEpochRef.current += 1;
      composingRef.current = false;
      onCompositionChange(tab.id, false);
      flushDeferredRendering();
    };
    const handleCompositionStart = () => {
      compositionEpochRef.current += 1;
      if (compositionReleaseTimeoutRef.current !== null) {
        window.clearTimeout(compositionReleaseTimeoutRef.current);
        compositionReleaseTimeoutRef.current = null;
      }
      if (composingRef.current) return;

      composingRef.current = true;
      clearQueuedRefresh(true);
      cancelQueuedFit();
      onCompositionChange(tab.id, true);
    };
    const queueCompositionRelease = (afterCompositionEnd = false) => {
      if (!composingRef.current) return;
      if (compositionReleaseTimeoutRef.current !== null) {
        if (!afterCompositionEnd) return;
        window.clearTimeout(compositionReleaseTimeoutRef.current);
      }

      const compositionEpoch = compositionEpochRef.current;
      compositionReleaseTimeoutRef.current = window.setTimeout(() => {
        compositionReleaseTimeoutRef.current = null;
        if (compositionEpoch !== compositionEpochRef.current) return;
        releaseComposition();
      }, 0);
    };
    const handleCompositionEnd = () => {
      // xterm queues its final composition commit from its earlier listener.
      // A blur fallback may already be queued, so place this release after it.
      queueCompositionRelease(true);
    };
    const handleTextAreaBlur = () => {
      queueCompositionRelease();
    };
    terminal.textarea?.addEventListener(
      "compositionstart",
      handleCompositionStart,
      true,
    );
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);
    terminal.textarea?.addEventListener("blur", handleTextAreaBlur);

    const resizeObserver = new ResizeObserver(() => queueFit());
    resizeObserver.observe(container);
    queueFit();
    onReady(tab.id, terminal, queueFit);

    return () => {
      if (compositionReleaseTimeoutRef.current !== null) {
        window.clearTimeout(compositionReleaseTimeoutRef.current);
        compositionReleaseTimeoutRef.current = null;
      }
      if (composingRef.current) {
        compositionEpochRef.current += 1;
        composingRef.current = false;
        onCompositionChange(tab.id, false);
      }
      inputDisposable.dispose();
      writeParsedDisposable.dispose();
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("keydown", handleTerminalKeyDown, true);
      container.removeEventListener("paste", handlePaste, true);
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      contextMenuActionsRef.current = null;
      clearQueuedRefresh();
      if (outputSettledTimeoutRef.current !== null) {
        window.clearTimeout(outputSettledTimeoutRef.current);
        outputSettledTimeoutRef.current = null;
      }
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
      terminal.textarea?.removeEventListener(
        "compositionstart",
        handleCompositionStart,
        true,
      );
      terminal.textarea?.removeEventListener("compositionend", handleCompositionEnd);
      terminal.textarea?.removeEventListener("blur", handleTextAreaBlur);
      resizeObserver.disconnect();
      requestFitRef.current = null;
      requestRefreshRef.current = null;
      onDispose(tab.id);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [
    onDispose,
    onCompositionChange,
    onInputError,
    onReady,
    onResize,
    onWriteError,
    tab.id,
    tab.shellProfileId,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (composingRef.current) {
      pendingFontSizeRef.current = terminalFontSize;
      pendingFitRef.current = true;
      pendingTextureRefreshRef.current = true;
      return;
    }

    terminal.options.fontSize = terminalFontSize;
    requestFitRef.current?.(true);
  }, [terminalFontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (composingRef.current) {
      pendingThemeRef.current = theme;
      pendingRefreshRef.current = true;
      pendingTextureRefreshRef.current = true;
      return;
    }

    terminal.options.theme = { ...TERMINAL_THEMES[theme] };
    requestRefreshRef.current?.(true);
  }, [theme]);

  useEffect(() => {
    if (!active || !terminalRef.current) {
      return;
    }

    const fit = () => {
      if (!activeRef.current) return;
      terminalRef.current?.focus();
      requestFitRef.current?.();
    };

    const frameId = window.requestAnimationFrame(fit);
    const timeoutIds = [window.setTimeout(fit, 60), window.setTimeout(fit, 180)];
    return () => {
      window.cancelAnimationFrame(frameId);
      timeoutIds.forEach((id) => window.clearTimeout(id));
    };
  }, [active]);

  return (
    <div
      className={["terminal-view", active ? "is-active" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={!active}
      ref={viewRef}
    >
      <div className="terminal-mount" ref={containerRef} />
      {contextMenu && active && (
        <div
          className="terminal-context-menu"
          ref={contextMenuRef}
          role="menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          <button
            disabled={!contextMenu.canCopy}
            onClick={() => {
              setContextMenu(null);
              void contextMenuActionsRef.current?.copy();
            }}
            role="menuitem"
            type="button"
          >
            复制
          </button>
          <button
            disabled={!contextMenu.canPaste}
            onClick={() => {
              setContextMenu(null);
              void contextMenuActionsRef.current?.paste();
            }}
            role="menuitem"
            type="button"
          >
            粘贴
          </button>
        </div>
      )}
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
    previous.copyOnSelect === next.copyOnSelect &&
    previous.terminalFontSize === next.terminalFontSize &&
    previous.theme === next.theme &&
    previous.onInputError === next.onInputError &&
    previous.onWriteError === next.onWriteError &&
    previous.onCompositionChange === next.onCompositionChange,
);
