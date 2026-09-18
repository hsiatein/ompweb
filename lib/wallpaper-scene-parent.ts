import type { SceneLayer } from "./wallpaper-scene-types";

type LayerTransform = Pick<SceneLayer, "id" | "origin" | "angle" | "scale" | "visible" | "parent" | "attachment" | "parallax" | "parallaxInherited">;
export interface SceneWorldTransform { matrix: number[]; visible: boolean; parallax: number[] }

export const sceneAlignments = ["center", "centre", "top", "bottom", "left", "right", "topleft", "topright", "bottomleft", "bottomright"];
export function sceneAlignmentOffset(alignment: string | undefined, size: number[]) {
  const value = alignment || "center";
  if (!sceneAlignments.includes(value)) throw new Error(`Invalid scene alignment: ${value}`);
  return [value.includes("left") ? size[0] / 2 : value.includes("right") ? -size[0] / 2 : 0,
    value.includes("bottom") ? size[1] / 2 : value.includes("top") ? -size[1] / 2 : 0];
}

// Keep the affine basis intact: rotation below a nonuniformly scaled parent
// creates shear, which cannot be represented by adding angles/scales.
export function sceneWorldTransforms(layers: LayerTransform[], attachment?: (parent: number, name: string) => number[]) {
  const byId = new Map(layers.map(l => [l.id, l])), result = new Map<number, SceneWorldTransform>(), visiting = new Set<number>();
  if (byId.size !== layers.length) throw new Error("Duplicate scene layer id");
  function visit(layer: LayerTransform): SceneWorldTransform {
    const cached = result.get(layer.id); if (cached) return cached;
    if (visiting.has(layer.id) || visiting.size >= 64) throw new Error("Cyclic or excessively deep scene parenting");
    visiting.add(layer.id);
    const c = Math.cos(layer.angle), s = Math.sin(layer.angle);
    let matrix = [c * layer.scale[0], s * layer.scale[0], -s * layer.scale[1], c * layer.scale[1], layer.origin[0], layer.origin[1]];
    let visible = layer.visible !== false, parallax = layer.parallax;
    if (layer.parent !== undefined) {
      const parent = byId.get(layer.parent); if (!parent) throw new Error(`Missing scene parent: ${layer.parent}`);
      if (layer.attachment && attachment) {
        const m = attachment(parent.id, layer.attachment), [a, b, c, d, x, y] = matrix;
        if (m.length !== 16 || m.some(n => !Number.isFinite(n))) throw new Error("Invalid scene attachment transform");
        matrix = [m[0] * a + m[4] * b, m[1] * a + m[5] * b, m[0] * c + m[4] * d, m[1] * c + m[5] * d, m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
      }
      const world = visit(parent), [a, b, c, d, x, y] = world.matrix, [e, f, g, h, u, v] = matrix;
      matrix = [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h, a * u + c * v + x, b * u + d * v + y];
      visible &&= world.visible; if (layer.parallaxInherited) parallax = world.parallax;
    }
    if (matrix.some(n => !Number.isFinite(n) || Math.abs(n) > 1e9)) throw new Error("Scene parent transform exceeds bounds");
    visiting.delete(layer.id);
    const value = { matrix, visible, parallax }; result.set(layer.id, value); return value;
  }
  for (const layer of layers) visit(layer);
  return result;
}
