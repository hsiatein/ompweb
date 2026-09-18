"use client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { parsePetPreferences, type PetInfo, type PetPreferences } from "@/lib/pets";

const STORAGE_KEY = "omp-web:pet";
const PREFERENCES_EVENT = "omp-web:pet-preferences";
const LIBRARY_EVENT = "omp-web:pet-library";
function snapshot() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function subscribe(listener: () => void) {
  window.addEventListener(PREFERENCES_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(PREFERENCES_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
export function usePetPreferences() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const preferences = useMemo(() => parsePetPreferences(raw), [raw]);
  const update = useCallback((changes: Partial<PetPreferences>) => {
    const next = parsePetPreferences(JSON.stringify({ ...parsePetPreferences(snapshot()), ...changes }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(PREFERENCES_EVENT));
  }, []);
  return { preferences, update };
}

export function notifyPetLibraryChanged() { window.dispatchEvent(new Event(LIBRARY_EVENT)); }
export function usePetLibrary() {
  const [pets, setPets] = useState<PetInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [skipped, setSkipped] = useState(0);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener(LIBRARY_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_EVENT, refresh);
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/pets", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load pet library");
        return response.json() as Promise<{ pets: PetInfo[]; skipped: number }>;
      })
      .then((result) => { setPets(result.pets); setSkipped(result.skipped); })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason.message || reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  return { pets, error, loading, skipped, refresh };
}
