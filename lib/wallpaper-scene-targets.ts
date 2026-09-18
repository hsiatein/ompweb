import type { ScenePass } from "./wallpaper-scene-types";

// Retire an intermediate only after its last reader. Inputs and output may
// never alias during a draw, even when their dimensions match.
export function sceneTargetPlan(passes: ScenePass[], size: number[]) {
  const lastRead = passes.map((_, i) => i);
  passes.forEach((pass, i) => {
    for (const source of Object.values(pass.inputs ?? { 0: i - 1 })) {
      if (!Number.isInteger(source) || source < -1 || source >= i) throw new Error("Invalid scene effect dependency");
      if (source >= 0) lastRead[source] = i;
    }
  });
  if (passes.length) lastRead[passes.length - 1] = Infinity;
  const slots: { width: number; height: number; until: number }[] = [];
  const assignments = passes.map((pass, i) => {
    const scale = pass.scale ?? 1;
    if (!Number.isFinite(scale) || scale < 1 || scale > 16) throw new Error("Invalid scene framebuffer scale");
    const width = Math.max(1, Math.ceil(size[0] / scale)), height = Math.max(1, Math.ceil(size[1] / scale));
    let slot = slots.findIndex(s => s.width === width && s.height === height && s.until < i);
    if (slot < 0) { slot = slots.length; slots.push({ width, height, until: 0 }); }
    slots[slot].until = lastRead[i];
    return slot;
  });
  return { slots, assignments, pixels: slots.reduce((n, s) => n + s.width * s.height, 0) };
}
