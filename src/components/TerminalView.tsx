import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizeTerminal, writeTerminal } from "../services/tauriApi";
import type { RuntimeTab } from "../types";

type TerminalViewProps = {
  tab: RuntimeTab;
  active: boolean;
  onImeAnchorReady?: (terminalId: string, refreshImeAnchor: () => void) => void;
  onReady: (terminalId: string, terminal: Terminal, fitAddon: FitAddon) => void;
  onDispose: (terminalId: string) => void;
};

export function TerminalView({
  tab,
  active,
  onImeAnchorReady,
  onReady,
  onDispose,
}: TerminalViewProps) {
  const [composing, setComposing] = useState(false);
  const [compositionText, setCompositionText] = useState("");
  const viewRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imeDockAnchorRef = useRef<HTMLSpanElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const composingRef = useRef(false);
  const syncImeAnchorRef = useRef<() => void>(() => undefined);
  const outputRefreshFrameRef = useRef<number | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: true,
      fontFamily:
        "Cascadia Mono, CaskaydiaCove Nerd Font, Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.16,
      scrollback: 8000,
      tabStopWidth: 4,
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

    const inputDisposable = terminal.onData((data) => {
      void writeTerminal(tab.id, data).catch((error) => {
        terminal.writeln(`\r\n[mutishell] 写入终端失败: ${String(error)}`);
      });
    });
    const syncImeAnchor = () => {
      const textarea = terminal.textarea;
      if (!textarea || !terminal.element) return;
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
      const dockAnchorRect = activeRef.current
        ? imeDockAnchorRef.current?.getBoundingClientRect()
        : undefined;
      const cursorX = Math.min(
        terminal.buffer.active.cursorX,
        Math.max(terminal.cols - 1, 0),
      );
      const cursorY = Math.min(
        terminal.buffer.active.cursorY,
        Math.max(terminal.rows - 1, 0),
      );
      const bottomReserve = 112;
      const viewportHeight =
        window.visualViewport?.height ?? document.documentElement.clientHeight;
      const cursorTop = cursorY * cellHeight;
      const cursorBottom = screenRect.top + cursorTop + cellHeight;
      const viewportOverflow = Math.max(
        0,
        cursorBottom + bottomReserve - viewportHeight,
      );
      const screenOverflow = Math.max(
        0,
        cursorTop + cellHeight + bottomReserve - screenRect.height,
      );
      const top = Math.max(
        0,
        dockAnchorRect
          ? dockAnchorRect.top - screenRect.top
          : cursorTop -
              (composingRef.current
                ? Math.max(viewportOverflow, screenOverflow)
                : 0),
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
      if (composingRef.current && dockAnchorRect) {
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
    syncImeAnchorRef.current = syncImeAnchor;
    const scheduleImeAnchorSync = () => {
      if (outputRefreshFrameRef.current !== null) return;
      outputRefreshFrameRef.current = window.requestAnimationFrame(() => {
        outputRefreshFrameRef.current = null;
        syncImeAnchor();
      });
    };
    const fit = () => {
      try {
        if (container.clientWidth < 40 || container.clientHeight < 40) return;
        fitAddon.fit();
        syncImeAnchor();
        void resizeTerminal(tab.id, terminal.cols, terminal.rows);
      } catch {
        // xterm can throw if the element is detached during fast tab switching.
      }
    };
    const scheduleFit = () => {
      window.requestAnimationFrame(() => {
        syncImeAnchor();
        window.requestAnimationFrame(syncImeAnchor);
      });
      window.setTimeout(syncImeAnchor, 40);
    };
    const cursorDisposable = terminal.onCursorMove(syncImeAnchor);
    const renderDisposable = terminal.onRender(scheduleImeAnchorSync);
    terminal.textarea?.addEventListener("focus", syncImeAnchor);
    onImeAnchorReady?.(tab.id, scheduleImeAnchorSync);
    const handleCompositionStart = () => {
      composingRef.current = true;
      setComposing(true);
      setCompositionText("");
      scheduleFit();
    };
    const handleCompositionUpdate = (event: CompositionEvent) => {
      setCompositionText(event.data);
      syncImeAnchor();
      window.requestAnimationFrame(syncImeAnchor);
    };
    const handleCompositionEnd = () => {
      composingRef.current = false;
      if (terminal.textarea) {
        terminal.textarea.style.position = "absolute";
      }
      setComposing(false);
      setCompositionText("");
      scheduleFit();
    };
    const keepDockImeAnchor = () => {
      if (!composingRef.current) return;
      syncImeAnchor();
      window.queueMicrotask(syncImeAnchor);
      window.requestAnimationFrame(syncImeAnchor);
    };
    terminal.textarea?.addEventListener("compositionstart", handleCompositionStart);
    terminal.textarea?.addEventListener("compositionupdate", handleCompositionUpdate);
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);
    terminal.textarea?.addEventListener("beforeinput", keepDockImeAnchor, true);
    terminal.textarea?.addEventListener("input", keepDockImeAnchor, true);

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fit);
    });
    resizeObserver.observe(container);
    window.requestAnimationFrame(fit);
    onReady(tab.id, terminal, fitAddon);

    return () => {
      inputDisposable.dispose();
      cursorDisposable.dispose();
      renderDisposable.dispose();
      if (outputRefreshFrameRef.current !== null) {
        window.cancelAnimationFrame(outputRefreshFrameRef.current);
        outputRefreshFrameRef.current = null;
      }
      terminal.textarea?.removeEventListener("focus", syncImeAnchor);
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
      syncImeAnchorRef.current = () => undefined;
    };
  }, [onDispose, onImeAnchorReady, onReady, tab.id]);

  useEffect(() => {
    if (!composing) return;

    const sync = () => syncImeAnchorRef.current();
    sync();
    const frameId = window.requestAnimationFrame(() => {
      sync();
      window.requestAnimationFrame(sync);
    });
    const timeoutId = window.setTimeout(sync, 40);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [composing, compositionText]);

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
        void resizeTerminal(tab.id, terminal.cols, terminal.rows);
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
  }, [active, tab.id]);

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
