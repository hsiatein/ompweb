import type { FileHandle } from "node:fs/promises";

// Pull directly from the verified handle; cancellation may race an in-flight read.
export function wallpaperFileStream(handle: FileHandle, start: number, end: number) {
  let position = start;
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= handle.close();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const buffer = new Uint8Array(Math.min(64 * 1024, end - position + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (closed) return;
        if (bytesRead > 0) { position += bytesRead; controller.enqueue(buffer.subarray(0, bytesRead)); }
        if (!bytesRead || position > end) {
          closed = true;
          controller.close();
          await close();
        }
      } catch (error) {
        if (!closed) { closed = true; controller.error(error); }
        await close().catch(() => {});
      }
    },
    async cancel() { closed = true; await close().catch(() => {}); },
  });
}
