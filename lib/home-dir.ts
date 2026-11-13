import { useSyncExternalStore } from "react";

// The server's home directory (`GET /api/home`), fetched once per page and
// shared by every component that shows or resolves `~` paths.
let home: string | null = null;
let loading = false;
const listeners = new Set<() => void>();

function load(): void {
  if (home || loading) return;
  loading = true;
  fetch("/api/home")
    .then((response) => response.json() as Promise<{ home?: unknown }>)
    .then((data) => {
      if (typeof data.home === "string" && data.home) {
        home = data.home;
        for (const listener of listeners) listener();
      }
    })
    .catch(() => {})
    .finally(() => { loading = false; });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

/** The server's home directory, or null until it has loaded (a failed load retries on the next subscriber). */
export function useHomeDir(): string | null {
  return useSyncExternalStore(subscribe, () => home, () => null);
}
