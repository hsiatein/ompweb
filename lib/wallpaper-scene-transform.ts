import type { BrowserScene } from "./wallpaper-scene-types";

export function sceneLayerOrigin(
  scene: Pick<BrowserScene, "width" | "height" | "cameraEffects">,
  origin: number[],
  depth: number[],
): number[] {
  if (!scene.cameraEffects.parallax) return [...origin];
  const amount = scene.cameraEffects.amount;
  // WE expands layer anchors around the scene center, without scaling the
  // layer's geometry. This offset also applies with zero mouse influence.
  return [
    origin[0] + (origin[0] - scene.width / 2) * depth[0] * amount,
    origin[1] + (origin[1] - scene.height / 2) * depth[1] * amount,
    origin[2] ?? 0,
  ];
}
