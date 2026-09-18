declare module "lz4js" {
  export function decompressBlock(src: Uint8Array, dst: Uint8Array, start: number, length: number, offset: number): number;
}
declare module "dxt-js" {
  const dxt: { decompress(data: Uint8Array, width: number, height: number, format: number): Uint8Array; flags: { DXT1: number; DXT3: number; DXT5: number } };
  export default dxt;
}
declare module "glsl-tokenizer/string" {
  export default function tokenize(source: string): { type: string; data: string }[];
}
