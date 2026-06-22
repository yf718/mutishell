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

export function formatTerminalPaths(paths: string[], shellProfileId: string) {
  const normalized = paths.filter((path) => path.length > 0);
  if (normalized.length === 0) return "";
  return (
    normalized.map((path) => quoteTerminalPath(path, shellProfileId)).join(" ") +
    " "
  );
}
