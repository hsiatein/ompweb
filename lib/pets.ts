export type PetState = "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";
export type PetActivity = { sessionKey: string; state: PetState };
export type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: 1 | 2;
  spritesheetPath: string;
};
export type PetInfo = PetManifest & { key: string; source: "codex" | "imported"; assetUrl: string };
export const PET_CELL = { width: 192, height: 208 };
export const PET_ROWS: Record<PetState, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

export function parsePetManifest(value: unknown): PetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pet.json");
  const data = value as Record<string, unknown>;
  const text = (key: string, max: number, fallback?: string) => {
    const field = data[key] ?? fallback;
    if (typeof field !== "string" || field.length > max || /[\x00-\x1f]/.test(field)) throw new Error(`Invalid ${key}`);
    return field.trim();
  };
  const id = text("id", 120);
  const displayName = text("displayName", 120);
  const description = text("description", 1000, "");
  const spritesheetPath = text("spritesheetPath", 160);
  const spriteVersionNumber = data.spriteVersionNumber ?? 1;
  if (!id || !displayName || (spriteVersionNumber !== 1 && spriteVersionNumber !== 2)) throw new Error("Unsupported pet version or missing name");
  // Only a sibling raster asset, never URLs, paths, scripts, or SVG.
  if (!/^[\p{L}\p{N}_ -][\p{L}\p{N}_. -]*\.(png|webp)$/iu.test(spritesheetPath) || spritesheetPath.includes("..")) {
    throw new Error("spritesheetPath must be a PNG or WebP filename");
  }
  return { id, displayName, description, spriteVersionNumber, spritesheetPath };
}

export function petFrame(state: PetState, elapsed: number): { row: number; column: number } {
  const { row, durations } = PET_ROWS[state];
  let time = Math.max(0, elapsed) % durations.reduce((a, b) => a + b, 0);
  for (let column = 0; column < durations.length; column++) {
    if (time < durations[column]) return { row, column };
    time -= durations[column];
  }
  return { row, column: 0 };
}

export function petLookFrame(dx: number, dy: number): { row: number; column: number } | null {
  if (Math.hypot(dx, dy) < 36) return null;
  const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.round(angle / (Math.PI / 8)) % 16;
  return { row: 9 + Math.floor(index / 8), column: index % 8 };
}

export function resolvePetState(input: { waiting: boolean; running: boolean; failed: boolean; completed: boolean }): PetState {
  if (input.waiting) return "waiting";
  if (input.running) return "running";
  if (input.failed) return "failed";
  return input.completed ? "review" : "idle";
}

export type PetPreferences = { enabled: boolean; key: string; size: number; followPointer: boolean; x: number; y: number };
export const DEFAULT_PET_PREFERENCES: PetPreferences = { enabled: false, key: "", size: 128, followPointer: true, x: 0.96, y: 0.65 };
export function parsePetPreferences(raw: string | null): PetPreferences {
  try {
    const p = JSON.parse(raw || "{}");
    const bound = (n: unknown, fallback: number, min: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    return {
      enabled: p.enabled === true,
      key: typeof p.key === "string" ? p.key : "",
      size: bound(p.size, 128, 72, 240),
      followPointer: p.followPointer !== false,
      x: bound(p.x, 0.96, 0, 1), y: bound(p.y, 0.65, 0, 1),
    };
  } catch { return DEFAULT_PET_PREFERENCES; }
}
