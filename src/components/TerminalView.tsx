import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizeTerminal, writeTerminal } from "../services/tauriApi";
import type { RuntimeTab } from "../types";

type TerminalViewProps = {
  tab: RuntimeTab;
  active: boolean;
  onReady: (terminalId: string, terminal: Terminal, fitAddon: FitAddon) => void;
  onDispose: (terminalId: string) => void;
};

export function TerminalView({
  tab,
  active,
  onReady,
  onDispose,
}: TerminalViewProps) {
  const [composing, setComposing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);

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
      const screenRect = screen?.getBoundingClientRect();
      if (!screenRect || screenRect.width <= 0 || screenRect.height <= 0) {
        return;
      }

      const cellWidth = screenRect.width / Math.max(terminal.cols, 1);
      const cellHeight = screenRect.height / Math.max(terminal.rows, 1);
      const cursorY = terminal.buffer.active.cursorY;
      const bottomReserve = 48;
      const bottomOverflow =
        cursorY * cellHeight + cellHeight + bottomReserve - screenRect.height;
      const top = Math.max(
        0,
        cursorY * cellHeight - Math.max(0, bottomOverflow),
      );
      textarea.style.left = `${terminal.buffer.active.cursorX * cellWidth}px`;
      textarea.style.top = `${top}px`;
      textarea.style.width = `${Math.max(cellWidth, 16)}px`;
      textarea.style.height = `${Math.max(cellHeight, 16)}px`;
      textarea.style.lineHeight = `${cellHeight}px`;
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
    const cursorDisposable = terminal.onCursorMove(syncImeAnchor);
    const renderDisposable = terminal.onRender(syncImeAnchor);
    terminal.textarea?.addEventListener("focus", syncImeAnchor);
    const handleCompositionStart = () => {
      setComposing(true);
      window.requestAnimationFrame(fit);
      window.setTimeout(fit, 40);
    };
    const handleCompositionUpdate = () => {
      syncImeAnchor();
      window.requestAnimationFrame(syncImeAnchor);
    };
    const handleCompositionEnd = () => {
      setComposing(false);
      window.requestAnimationFrame(fit);
      window.setTimeout(fit, 40);
    };
    terminal.textarea?.addEventListener("compositionstart", handleCompositionStart);
    terminal.textarea?.addEventListener("compositionupdate", handleCompositionUpdate);
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);

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
      resizeObserver.disconnect();
      onDispose(tab.id);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onDispose, onReady, tab.id]);

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
    >
      <div className="terminal-mount" ref={containerRef} />
    </div>
  );
}
