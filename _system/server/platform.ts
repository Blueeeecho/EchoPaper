import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findInPath(names: string[], skipWindowsStoreStub = false): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (skipWindowsStoreStub && /\\Microsoft\\WindowsApps(?:\\|$)/i.test(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export const pythonExecutable = () => {
  if (process.env.ECHOPAPER_PYTHON_PATH) return process.env.ECHOPAPER_PYTHON_PATH;
  if (process.platform === 'win32') {
    const found = findInPath(['python.exe', 'python3.exe'], true);
    if (found) return found;
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const pyRoot = path.join(localAppData, 'Programs', 'Python');
      try {
        for (const entry of fs.readdirSync(pyRoot).sort().reverse()) {
          if (!/^Python3\d+$/i.test(entry)) continue;
          const candidate = path.join(pyRoot, entry, 'python.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* ignore */ }
    }
    return 'python';
  }
  return '/usr/bin/python3';
};

export const gitExecutable = () => {
  if (process.env.ECHOPAPER_GIT_PATH) return process.env.ECHOPAPER_GIT_PATH;
  if (process.platform === 'win32') {
    const found = findInPath(['git.exe']);
    if (found) return found;
    for (const candidate of ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'git.exe';
  }
  return '/usr/bin/git';
};

export const tectonicExecutable = () => {
  if (process.env.TECTONIC_PATH) return process.env.TECTONIC_PATH;
  const bin = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';
  const found = findInPath([bin]);
  if (found) return found;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(os.homedir(), '.cargo', 'bin', 'tectonic.exe'),
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'tectonic', 'tectonic.exe')] : []),
      path.join(os.homedir(), 'scoop', 'shims', 'tectonic.exe'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'tectonic.exe';
  }
  if (process.platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic', path.join(os.homedir(), '.cargo/bin/tectonic')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return '/opt/homebrew/bin/tectonic';
  }
  return 'tectonic';
};
export const credentialStoreName = () => process.platform === 'win32' ? 'Windows Credential Manager' : 'macOS Keychain';
export const disabledGitHooks = () => os.devNull;
