export interface CropRect { x: number; y: number; width: number; height: number }
export interface WallpaperCropGeometry {
  image: CropRect;
  crop: CropRect;
  travelX: number;
  travelY: number;
}

export function wallpaperCropGeometry(
  source: { width: number; height: number },
  preview: { width: number; height: number },
  viewport: { width: number; height: number },
  position: { positionX: number; positionY: number },
  fit: "cover" | "contain",
): WallpaperCropGeometry | null {
  if (![source.width, source.height, preview.width, preview.height, viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(preview.width / source.width, preview.height / source.height);
  const image = { width: source.width * scale, height: source.height * scale, x: 0, y: 0 };
  image.x = (preview.width - image.width) / 2;
  image.y = (preview.height - image.height) / 2;
  const ratio = viewport.width / viewport.height;
  const width = fit === "contain" ? image.width : Math.min(image.width, image.height * ratio);
  const height = fit === "contain" ? image.height : Math.min(image.height, image.width / ratio);
  const travelX = Math.max(0, image.width - width);
  const travelY = Math.max(0, image.height - height);
  return { image, travelX, travelY, crop: {
    x: image.x + travelX * position.positionX / 100,
    y: image.y + travelY * position.positionY / 100,
    width, height,
  } };
}

export function moveWallpaperCrop(geometry: WallpaperCropGeometry, x: number, y: number, previous: { positionX: number; positionY: number }) {
  const percent = (offset: number, travel: number, fallback: number) => travel > 0.01
    ? Math.round(Math.max(0, Math.min(100, offset / travel * 100)) * 10) / 10 : fallback;
  return {
    positionX: percent(x - geometry.image.x, geometry.travelX, previous.positionX),
    positionY: percent(y - geometry.image.y, geometry.travelY, previous.positionY),
  };
}
