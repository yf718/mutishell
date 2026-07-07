import type { Terminal } from "@xterm/xterm";
import { saveSystemClipboardFiles, writeTerminal } from "../services/tauriApi";
import { formatTerminalPaths, MAX_TERMINAL_PATHS } from "./terminalPaths";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

type PasteManagerRequest = {
  fallbackText?: string;
  onInputError: (message: string) => void;
  onWriteError: (terminalId: string, error: unknown) => void;
  shellProfileId: string;
  terminal: Terminal;
  terminalId: string;
};

function hasLineBreak(text: string) {
  return /[\r\n]/.test(text);
}

function isAlreadyBracketedPaste(text: string) {
  return (
    text.startsWith(BRACKETED_PASTE_START) &&
    text.endsWith(BRACKETED_PASTE_END)
  );
}

function prepareTextForTerminalInput(text: string) {
  return text.replace(/\r?\n/g, "\r");
}

function prepareTextForBracketedPaste(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
}

function makePastePayload(text: string, terminal: Terminal) {
  if (text.length === 0) return "";
  if (isAlreadyBracketedPaste(text)) return text;

  // Multiline paste must stay atomic even if xterm's mode snapshot is stale.
  const shouldBracket = terminal.modes.bracketedPasteMode || hasLineBreak(text);
  const prepared = shouldBracket
    ? prepareTextForBracketedPaste(text)
    : prepareTextForTerminalInput(text);

  return shouldBracket
    ? `${BRACKETED_PASTE_START}${prepared}${BRACKETED_PASTE_END}`
    : prepared;
}

async function readClipboardText(fallbackText = "") {
  if (fallbackText.length > 0) return fallbackText;
  return navigator.clipboard?.readText().catch(() => "") ?? "";
}

function writePastePayload({
  onWriteError,
  terminal,
  terminalId,
  text,
}: {
  onWriteError: (terminalId: string, error: unknown) => void;
  terminal: Terminal;
  terminalId: string;
  text: string;
}) {
  if (text.length === 0) return;
  terminal.focus();
  if (terminal.textarea) {
    terminal.textarea.value = "";
  }
  void writeTerminal(terminalId, text).catch((error) =>
    onWriteError(terminalId, error),
  );
}

export async function pasteManager({
  fallbackText = "",
  onInputError,
  onWriteError,
  shellProfileId,
  terminal,
  terminalId,
}: PasteManagerRequest) {
  const paths = await saveSystemClipboardFiles().catch((error) => {
    onInputError(`粘贴文件失败: ${String(error)}`);
    return [];
  });

  if (paths.length > 0) {
    const { text, omitted } = formatTerminalPaths(paths, shellProfileId);
    if (omitted > 0) {
      onInputError(
        `一次最多插入 ${MAX_TERMINAL_PATHS} 个路径，已忽略 ${omitted} 个`,
      );
    }
    writePastePayload({ onWriteError, terminal, terminalId, text });
    return;
  }

  const text = await readClipboardText(fallbackText);
  const payload = makePastePayload(text, terminal);
  writePastePayload({ onWriteError, terminal, terminalId, text: payload });
}
