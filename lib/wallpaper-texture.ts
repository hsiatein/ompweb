import sharp from "sharp";
import dxt from "dxt-js";
import { decompressBlock } from "lz4js";
import { WallpaperReader } from "./wallpaper-binary";

export interface TextureFrame { x: number; y: number; width: number; height: number; duration: number; axes?: number[]; }
export interface DecodedTexture { png: Buffer; video?: Buffer; width: number; height: number; format: number; frames: TextureFrame[]; }
const MAX_PIXELS = 64 * 1024 * 1024;
function dimensions(w: number, h: number, maxPixels = MAX_PIXELS) {
  if (w < 1 || h < 1 || w > 16384 || h > 16384 || w * h > maxPixels) throw new Error(`Scene texture exceeds safe dimensions (${w}x${h}, limit ${maxPixels} pixels)`);
}
function lz4(data: Buffer, size: number) {
  if (size < 1 || size > MAX_PIXELS * 4) throw new Error("Invalid texture decoded size");
  // Validate lengths before passing an untrusted block to the library.
  let input = 0, output = 0;
  while (input < data.length) {
    const token = data[input++];
    let literal = token >> 4;
    if (literal === 15) { let n; do { if (input >= data.length) throw new Error("Invalid LZ4 literals"); n = data[input++]; literal += n; } while (n === 255); }
    input += literal; output += literal;
    if (input > data.length || output > size) throw new Error("Invalid LZ4 size");
    if (input === data.length) break;
    if (input + 2 > data.length) throw new Error("Invalid LZ4 match");
    const distance = data.readUInt16LE(input); input += 2;
    if (!distance || distance > output) throw new Error("Invalid LZ4 distance");
    let length = (token & 15) + 4;
    if ((token & 15) === 15) { let n; do { if (input >= data.length) throw new Error("Invalid LZ4 length"); n = data[input++]; length += n; } while (n === 255); }
    output += length;
    if (output > size) throw new Error("Invalid LZ4 output");
  }
  if (output !== size) throw new Error("Incomplete LZ4 texture");
  const result = Buffer.alloc(size);
  if (decompressBlock(data, result, 0, data.length, 0) !== size) throw new Error("Texture decompression failed");
  return result;
}

// TEXV/TEXI/TEXB/TEXS layouts documented by RePKG. Keep the first (full-size) mip.
export async function decodeWallpaperTexture(bytes: Buffer): Promise<DecodedTexture> {
  const r = new WallpaperReader(bytes);
  if (r.magic() !== "TEXV0005" || r.magic() !== "TEXI0001") throw new Error("Unsupported scene texture");
  const format = r.int(); r.uint();
  const tw = r.uint(), th = r.uint(), iw = r.uint(), ih = r.uint(); r.uint();
  dimensions(tw, th); dimensions(iw, ih, 32 * 1024 * 1024);
  const version = r.magic();
  if (!/^TEXB000[1-4]$/.test(version)) throw new Error("Unsupported texture container");
  const images = r.uint();
  if (images !== 1) throw new Error("Multi-image scene textures are not supported yet");
  const encodedFormat = version >= "TEXB0003" ? r.int() : -1;
  if (version === "TEXB0004") r.uint();
  const mips = r.uint();
  if (!mips || mips > 16) throw new Error("Invalid mipmap count");
  let pixels: Buffer | undefined, width = 0, height = 0;
  for (let i = 0; i < mips; i++) {
    const w = r.uint(), h = r.uint(); dimensions(w, h);
    const compressed = version !== "TEXB0001" ? r.uint() : 0;
    const size = version !== "TEXB0001" ? r.uint() : 0;
    const raw = r.take(r.uint());
    if (i === 0) { width = w; height = h; pixels = compressed ? lz4(raw, size) : raw; }
  }
  if (!pixels || iw > width || ih > height) throw new Error("Invalid texture image size");
  if (pixels.toString("ascii", 4, 8) === "ftyp") return { png: Buffer.alloc(0), video: pixels, width: iw, height: ih, format, frames: [] };
  const frames: TextureFrame[] = [];
  if (r.offset < bytes.length) {
    const magic = r.magic();
    if (!/^TEXS000[1-3]$/.test(magic)) throw new Error("Unsupported texture animation");
    const count = r.uint();
    if (count > 2048) throw new Error("Too many texture frames");
    if (magic === "TEXS0003") { r.uint(); r.uint(); }
    for (let i = 0; i < count; i++) {
      const image = r.uint(); const duration = r.float();
      const read = () => magic === "TEXS0001" ? r.int() : r.float();
      const x = read(), y = read(), w = read(), wy = read(), hx = read(), h = read();
      // These are sampling coordinates, not byte offsets. Some shipped
      // particle atlases contain edge/outside frames; preserve the UVs and
      // let the sampler clamp them, just as it does for a shader's own UVs.
      if (image !== 0 || ![x, y, w, wy, hx, h].every(v => Number.isFinite(v) && Math.abs(v) <= 16384) || Math.abs(w * h - wy * hx) < .001) throw new Error("Invalid texture atlas frame");
      frames.push({ x: x / width, y: y / height, width: Math.hypot(w, wy) / width, height: Math.hypot(hx, h) / height, axes: [w / width, wy / height, hx / width, h / height], duration: Number.isFinite(duration) && duration > 0 ? duration : 1 / 30 });
    }
  }
  let png: Buffer;
  const outputWidth = frames.length ? width : iw, outputHeight = frames.length ? height : ih;
  if (encodedFormat !== -1) {
    const image = sharp(pixels, { limitInputPixels: MAX_PIXELS });
    const metadata = await image.metadata();
    if (!((metadata.width === width && metadata.height === height) || (metadata.width === iw && metadata.height === ih))) throw new Error("Encoded texture dimensions do not match its header");
    png = await image.extract({ left: 0, top: 0, width: outputWidth, height: outputHeight }).ensureAlpha().png().toBuffer();
  } else {
    let rgba: Buffer;
    if ([4, 6, 7].includes(format)) {
      const blockSize = format === 7 ? 8 : 16;
      if (pixels.length !== Math.ceil(width / 4) * Math.ceil(height / 4) * blockSize) throw new Error("Invalid DXT texture length");
      rgba = Buffer.from(dxt.decompress(pixels, width, height, format === 7 ? dxt.flags.DXT1 : format === 6 ? dxt.flags.DXT3 : dxt.flags.DXT5));
    } else if (format === 0) {
      rgba = pixels;
    } else if (format === 8 || format === 9) {
      const channels = format === 8 ? 2 : 1;
      if (pixels.length !== width * height * channels) throw new Error("Invalid channel texture length");
      rgba = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = pixels[i * channels];
        rgba[i * 4 + 1] = channels === 2 ? pixels[i * channels + 1] : 0;
        rgba[i * 4 + 3] = 255;
      }
    } else throw new Error(`Unsupported scene texture format ${format}`);
    if (rgba.length !== width * height * 4) throw new Error("Invalid RGBA texture length");
    png = await sharp(rgba, { raw: { width, height, channels: 4 } }).extract({ left: 0, top: 0, width: outputWidth, height: outputHeight }).png().toBuffer();
  }
  return { png, width: outputWidth, height: outputHeight, format, frames };
}
