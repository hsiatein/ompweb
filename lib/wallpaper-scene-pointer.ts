export function sceneCursorPosition(
  scene: { width: number; height: number },
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number }, fit: string, position = "50% 50%",
) {
  if (rect.width <= 0 || rect.height <= 0) return [0, 0, 0];
  let width = rect.width, height = rect.height;
  if (fit === "cover" || fit === "contain") {
    const scale = (fit === "cover" ? Math.max : Math.min)(width / scene.width, height / scene.height);
    width = scene.width * scale; height = scene.height * scale;
  }
  const parts = position.split(/\s+/);
  const offset = (part: string | undefined, space: number) => part?.endsWith("%") ? space * parseFloat(part) / 100 : part?.endsWith("px") ? parseFloat(part) : space / 2;
  const x = point.x - rect.left - offset(parts[0], rect.width - width);
  const y = point.y - rect.top - offset(parts[1], rect.height - height);
  return [x / width * scene.width, (1 - y / height) * scene.height, 0];
}

export function pointInSceneMesh(x: number, y: number, positions: ArrayLike<number>, indices: ArrayLike<number>) {
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], bx = positions[b], by = positions[b + 1], cx = positions[c], cy = positions[c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / area;
    const v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
    if (u >= 0 && v >= 0 && u + v <= 1) return true;
  }
  return false;
}
