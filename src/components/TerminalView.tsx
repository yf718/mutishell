import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
  const [composing, setComposing] = useState(false);
  const [compositionText, setCompositionText] = useState("");
  const viewRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imeDockAnchorRef = useRef<HTMLSpanElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const statusRef = useRef(tab.status);
  const rightClickPasteRef = useRef(rightClickPaste);
  const copyOnSelectRef = useRef(copyOnSelect);
  const composingRef = useRef(false);
  const imeAnchorFrameRef = useRef<number | null>(null);
  const refreshFrameRef = useRef<number | null>(null);
  const refreshTimeoutRef = useRef<number | null>(null);
  const outputSettledTimeoutRef = useRef<number | null>(null);
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
      hideCursorDuringOutput();
    });
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

    const syncImeAnchor = () => {
      const textarea = terminal.textarea;
      if (!textarea || !terminal.element) return;
      if (!composingRef.current) return;
      const screen = terminal.element.querySelector(".xterm-screen");
      const compositionView = terminal.element.querySelector<HTMLElement>(
        ".composition-view",
      );
      const screenRect = screen?.getBoundingClientRect();
      if (!screenRect || screenRect.width <= 0 || screenRect.height <= 0) {
        return;
      }

      const cellWidth = screenRect.width / Math.max(terminal.cols, 1);
      const cellHeight = screenRect.height / Math.max(terminal.rows, 1);
      const dockAnchorRect = imeDockAnchorRef.current?.getBoundingClientRect();
      const cursorX = Math.min(
        terminal.buffer.active.cursorX,
        Math.max(terminal.cols - 1, 0),
      );
      const cursorY = Math.min(
        terminal.buffer.active.cursorY,
        Math.max(terminal.rows - 1, 0),
      );
      const cursorTop = cursorY * cellHeight;
      const top = Math.max(
        0,
        dockAnchorRect ? dockAnchorRect.top - screenRect.top : cursorTop,
      );
      const left = dockAnchorRect
        ? dockAnchorRect.left - screenRect.left
        : cursorX * cellWidth;
      const fixedLeft = dockAnchorRect?.left ?? screenRect.left + left;
      const fixedTop = dockAnchorRect?.top ?? screenRect.top + top;
      viewRef.current?.style.setProperty("--ime-anchor-left", `${left}px`);
      viewRef.current?.style.setProperty("--ime-anchor-top", `${top}px`);
      viewRef.current?.style.setProperty("--ime-anchor-fixed-left", `${fixedLeft}px`);
      viewRef.current?.style.setProperty("--ime-anchor-fixed-top", `${fixedTop}px`);
      viewRef.current?.style.setProperty(
        "--ime-anchor-width",
        `${dockAnchorRect ? Math.max(dockAnchorRect.width, 120) : Math.max(cellWidth, 16)}px`,
      );
      viewRef.current?.style.setProperty(
        "--ime-anchor-height",
        `${Math.max(cellHeight, 16)}px`,
      );
      textarea.style.left = `${left}px`;
      textarea.style.top = `${top}px`;
      if (dockAnchorRect) {
        textarea.style.position = "fixed";
        textarea.style.left = `${fixedLeft}px`;
        textarea.style.top = `${fixedTop}px`;
      } else {
        textarea.style.position = "absolute";
      }
      textarea.style.width = `${
        dockAnchorRect ? Math.max(dockAnchorRect.width, 120) : Math.max(cellWidth, 16)
      }px`;
      textarea.style.height = `${Math.max(cellHeight, 16)}px`;
      textarea.style.lineHeight = `${cellHeight}px`;
      textarea.style.zIndex = "20";
      if (compositionView) {
        compositionView.style.left = `${left}px`;
        compositionView.style.top = `${top}px`;
        compositionView.style.lineHeight = `${cellHeight}px`;
      }
    };
    const fit = () => {
      try {
        if (container.clientWidth < 40 || container.clientHeight < 40) return;
        const previousSize = `${terminal.cols}x${terminal.rows}`;
        fitAddon.fit();
        const nextSize = `${terminal.cols}x${terminal.rows}`;
        const sizeChanged = previousSize !== nextSize || lastFitSizeRef.current !== nextSize;
        lastFitSizeRef.current = nextSize;
        syncImeAnchor();
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
    const queueImeAnchorSync = () => {
      if (!composingRef.current || imeAnchorFrameRef.current !== null) return;
      imeAnchorFrameRef.current = window.requestAnimationFrame(() => {
        imeAnchorFrameRef.current = null;
        syncImeAnchor();
      });
    };
    const handleCompositionStart = () => {
      composingRef.current = true;
      setComposing(true);
      setCompositionText("");
      queueImeAnchorSync();
    };
    const handleCompositionUpdate = (event: CompositionEvent) => {
      setCompositionText(event.data);
      queueImeAnchorSync();
    };
    const handleCompositionEnd = () => {
      composingRef.current = false;
      if (terminal.textarea) {
        terminal.textarea.style.position = "absolute";
        terminal.textarea.style.zIndex = "";
      }
      setComposing(false);
      setCompositionText("");
    };
    const keepDockImeAnchor = () => {
      queueImeAnchorSync();
    };
    terminal.textarea?.addEventListener("compositionstart", handleCompositionStart);
    terminal.textarea?.addEventListener("compositionupdate", handleCompositionUpdate);
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);
    terminal.textarea?.addEventListener("beforeinput", keepDockImeAnchor, true);
    terminal.textarea?.addEventListener("input", keepDockImeAnchor, true);

    const resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(container);
    queueFit();
    onReady(tab.id, terminal, fitAddon);

    return () => {
      inputDisposable.dispose();
      writeParsedDisposable.dispose();
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("paste", handlePaste, true);
      clearQueuedRefresh();
      if (outputSettledTimeoutRef.current !== null) {
        window.clearTimeout(outputSettledTimeoutRef.current);
        outputSettledTimeoutRef.current = null;
      }
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
      if (imeAnchorFrameRef.current !== null) {
        window.cancelAnimationFrame(imeAnchorFrameRef.current);
        imeAnchorFrameRef.current = null;
      }
      terminal.textarea?.removeEventListener(
        "compositionstart",
        handleCompositionStart,
      );
      terminal.textarea?.removeEventListener(
        "compositionupdate",
        handleCompositionUpdate,
      );
      terminal.textarea?.removeEventListener(
        "compositionend",
        handleCompositionEnd,
      );
      terminal.textarea?.removeEventListener("beforeinput", keepDockImeAnchor, true);
      terminal.textarea?.removeEventListener("input", keepDockImeAnchor, true);
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
      className={[
        "terminal-view",
        active ? "is-active" : "",
        composing ? "is-composing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={!active}
      ref={viewRef}
      style={{
        "--ime-anchor-fixed-left": "220px",
        "--ime-anchor-fixed-top": "calc(100vh - 76px)",
      } as CSSProperties}
    >
      <div className="terminal-mount" ref={containerRef} />
      <div className="terminal-ime-dock" aria-hidden="true">
        <span className="terminal-ime-prompt">IME</span>
        <span className="terminal-ime-text" ref={imeDockAnchorRef}>
          {compositionText || " "}
        </span>
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
