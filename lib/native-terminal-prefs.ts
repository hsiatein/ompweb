/**
 * Client-safe "Copy terminal command" preferences (localStorage, per device).
 * A web page cannot start programs, so the workspace menu copies a command that
 * opens a shell in the workspace directory: `cd <dir>` for a terminal on the
 * omp-web machine, or an ssh command for another computer.
 */

/** auto: `cd` when the page URL is loopback, ssh otherwise. local: always `cd`. ssh: always ssh. */
export type TerminalCommandMode = "auto" | "local" | "ssh";

const MODE_KEY = "omp-web:native-terminal-mode";
const HOST_KEY = "omp-web:native-terminal-ssh-host";

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // storage unavailable: the preference just won't persist
  }
}

export function getTerminalCommandMode(): TerminalCommandMode {
  const value = read(MODE_KEY);
  return value === "local" || value === "ssh" ? value : "auto";
}

export function setTerminalCommandMode(mode: TerminalCommandMode): void {
  write(MODE_KEY, mode === "auto" ? "" : mode);
}

/** The ssh destination as typed (an ~/.ssh/config alias like `nas`, or user@host). */
export function getTerminalSshHost(): string {
  return read(HOST_KEY)?.trim() ?? "";
}

export function setTerminalSshHost(host: string): void {
  write(HOST_KEY, host.trim());
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** POSIX single-quoting: safe for any byte string except NUL. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command to copy: `cd <dir>`, or `ssh -t <host> 'cd <dir> && exec "$SHELL" -l'` (POSIX shells). */
export function terminalCommand(mode: TerminalCommandMode, pageHostname: string, sshHost: string, dir: string): string {
  const local = mode === "local" || (mode === "auto" && isLoopbackHostname(pageHostname));
  if (local) return `cd ${shellQuote(dir)}`;
  return `ssh -t ${shellQuote(sshHost || pageHostname)} ${shellQuote(`cd ${shellQuote(dir)} && exec "$SHELL" -l`)}`;
}
