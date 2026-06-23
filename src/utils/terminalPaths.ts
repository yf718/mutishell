export const MAX_TERMINAL_PATHS = 10;

export type FormattedTerminalPaths = {
  text: string;
  omitted: number;
};

function quotePowerShellPath(path: string) {
  return `'${path.replace(/'/g, "''")}'`;
}

function quoteCmdPath(path: string) {
  return `"${path}"`;
}

function quotePosixPath(path: string) {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function toGitBashPath(path: string) {
  return path.replace(/\\/g, "/");
}

function toWslPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const drivePath = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!drivePath) return normalized;
  return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2]}`;
}

export function quoteTerminalPath(path: string, shellProfileId: string) {
  if (shellProfileId === "powershell" || shellProfileId === "pwsh") {
    return quotePowerShellPath(path);
  }
  if (shellProfileId === "cmd") {
    return quoteCmdPath(path);
  }
  if (shellProfileId === "git-bash") {
    return quotePosixPath(toGitBashPath(path));
  }
  if (shellProfileId === "wsl") {
    return quotePosixPath(toWslPath(path));
  }
  return quoteCmdPath(path);
}

export function formatTerminalPaths(
  paths: string[],
  shellProfileId: string,
): FormattedTerminalPaths {
  const normalized = paths.filter((path) => path.length > 0);
  if (normalized.length === 0) {
    return { text: "", omitted: 0 };
  }

  const limited = normalized.slice(0, MAX_TERMINAL_PATHS);
  return {
    text:
      limited.map((path) => quoteTerminalPath(path, shellProfileId)).join(" ") +
      " ",
    omitted: normalized.length - limited.length,
  };
}
