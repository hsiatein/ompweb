import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { resolveWebProject } from "./wallpaper-store";

const state = globalThis as typeof globalThis & { __ompWallpaperWebSecret?: Buffer };
const secret = state.__ompWallpaperWebSecret ??= randomBytes(32);
const signature = (id: string) => createHmac("sha256", secret).update(`wallpaper:${id}`).digest("hex");
export function validWebWallpaperToken(id: string, token: string) {
  return /^[a-f0-9]{32}$/.test(id) && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(signature(id), "hex"), Buffer.from(token, "hex"));
}
export async function webWallpaperManifest(id: string) {
  const project = await resolveWebProject(id);
  return { url: `/api/wallpapers/${id}/web-assets/${signature(id)}/${project.file.split("/").map(encodeURIComponent).join("/")}` };
}

// Runs entirely inside an opaque-origin iframe, without access to the application.
function bootstrap(properties: Record<string, unknown>, resizeReload: boolean) {
  const win = window as typeof window & { wallpaperPropertyListener?: Record<string, (...args: unknown[]) => void> };
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  let paused = false, volume = 0, counter = 0, applyingGeneral = false, listener: typeof win.wallpaperPropertyListener;
  const callbacks = new Map<number, { callback: FrameRequestCallback; native?: number }>();
  const schedule = (id: number) => {
    const item = callbacks.get(id);
    if (item && !paused) item.native = raf(time => { item.native = undefined; if (!paused) { callbacks.delete(id); item.callback(time); } });
  };
  window.requestAnimationFrame = callback => { const id = ++counter; callbacks.set(id, { callback }); schedule(id); return id; };
  window.cancelAnimationFrame = id => { const item = callbacks.get(id); if (item?.native) caf(item.native); callbacks.delete(id); };
  const general = () => {
    applyingGeneral = true;
    try { listener?.applyGeneralProperties?.({ fps: 60, audioVolume: volume * 100 }); }
    finally { applyingGeneral = false; }
  };
  const apply = () => { listener?.applyUserProperties?.(properties); general(); listener?.setPaused?.(paused); };
  Object.defineProperty(win, "wallpaperPropertyListener", { configurable: true, get: () => listener, set: value => { listener = value; queueMicrotask(apply); } });
  const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
  Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, get: imageSrc.get, set(value) { this.crossOrigin = "anonymous"; imageSrc.set!.call(this, value); } });
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  const originalVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!;
  const mediaVolumes = new WeakMap<HTMLMediaElement, number>(), requested = new Set<HTMLMediaElement>();
  Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get() { return mediaVolumes.get(this) ?? originalVolume.get!.call(this); }, set(value) {
    originalVolume.set!.call(this, value);
    // Values assigned by the native volume callback already include master gain.
    const authored = applyingGeneral ? (volume > 0 ? Number(value) / volume : mediaVolumes.get(this) ?? 1) : Number(value);
    mediaVolumes.set(this, authored); originalVolume.set!.call(this, Math.min(1, authored * volume));
  } });
  function syncMedia(el: HTMLMediaElement) {
    if (!mediaVolumes.has(el)) mediaVolumes.set(el, originalVolume.get!.call(el));
    originalVolume.set!.call(el, Math.min(1, mediaVolumes.get(el)! * volume));
  }
  HTMLMediaElement.prototype.play = function () {
    requested.add(this); syncMedia(this);
    return paused ? Promise.resolve() : originalPlay.call(this).catch((error: Error) => { if (error.name !== "NotAllowedError" && error.name !== "AbortError") throw error; });
  };
  HTMLMediaElement.prototype.pause = function () { requested.delete(this); originalPause.call(this); };
  // Wallpaper scripts occasionally use storage; keep it isolated and ephemeral.
  for (const name of ["localStorage", "sessionStorage"]) {
    const values = new Map<string, string>();
    Object.defineProperty(window, name, { value: { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(String(key)) ?? null, setItem: (key: string, value: string) => { values.set(String(key), String(value)); }, removeItem: (key: string) => { values.delete(String(key)); }, clear: () => values.clear() } });
  }
  window.addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "omp-wallpaper-state") return;
    paused = event.data.paused === true;
    if (typeof event.data.volume === "number" && Number.isFinite(event.data.volume)) volume = Math.max(0, Math.min(1, event.data.volume));
    for (const [id, item] of callbacks) { if (item.native) caf(item.native); item.native = undefined; schedule(id); }
    for (const el of new Set([...document.querySelectorAll<HTMLMediaElement>("video,audio"), ...requested])) { syncMedia(el); if (paused) originalPause.call(el); else if ((el.autoplay || requested.has(el)) && (!el.ended || el.loop)) void el.play().catch(() => {}); }
    general();
    listener?.setPaused?.(paused);
  });
  window.addEventListener("load", () => { apply(); parent.postMessage({ type: "omp-wallpaper-ready" }, "*"); });
  window.addEventListener("error", event => { if (event.message) parent.postMessage({ type: "omp-wallpaper-error", message: event.message.slice(0, 300) }, "*"); });
  window.addEventListener("unhandledrejection", event => parent.postMessage({ type: "omp-wallpaper-error", message: String(event.reason?.message || event.reason).slice(0, 300) }, "*"));
  if (resizeReload) {
    let timer: number;
    window.addEventListener("resize", () => { clearTimeout(timer); timer = window.setTimeout(() => location.reload(), 250); });
  }
}

export function webWallpaperHtml(html: string, metadata: Record<string, unknown>) {
  const document = parse(html);
  type Node = DefaultTreeAdapterMap["node"];
  type Element = DefaultTreeAdapterMap["element"];
  let head: Element | undefined;
  function walk(node: Node) {
    if ("tagName" in node) {
      if (node.tagName === "head") head = node;
      if (["img", "video", "audio"].includes(node.tagName)) node.attrs.push({ name: "crossorigin", value: "anonymous" });
    }
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(child => !("tagName" in child && (child.tagName === "base" || (child.tagName === "link" && child.attrs.some(a => a.name === "href" && /^https?:\/\//i.test(a.value))))));
      node.childNodes.forEach(walk);
    }
  }
  walk(document);
  // Some RainEffect workshop exports removed the navigation markup but kept
  // the slideshow script which dereferences those links during initialization.
  if (String(metadata.description || "").includes("github.com/codrops/RainEffect")) {
    const elements: Element[] = [];
    function collect(node: Node) { if ("tagName" in node) elements.push(node); if ("childNodes" in node) node.childNodes.forEach(collect); }
    collect(document);
    const hasClass = (el: Element, name: string) => el.attrs.some(a => a.name === "class" && a.value.split(/\s+/).includes(name));
    const nav = elements.find(el => hasClass(el, "slideshow__nav"));
    if (nav) for (const slide of elements.filter(el => hasClass(el, "slide"))) {
      const id = slide.attrs.find(a => a.name === "id")?.value;
      if (!id || elements.some(el => el.attrs.some(a => a.name === "href" && a.value === `#${id}`))) continue;
      const link = parseFragment('<a hidden aria-hidden="true" tabindex="-1"></a>').childNodes[0] as Element;
      link.attrs.push({ name: "href", value: `#${id}` }); link.parentNode = nav; nav.childNodes.push(link);
    }
  }
  const general = metadata.general as { properties?: Record<string, unknown> } | undefined;
  const properties = { ...general?.properties };
  for (const [key, value] of Object.entries(metadata.preset as object || {})) properties[key] = { ...(properties[key] as object || {}), value };
  const config = JSON.stringify(properties).replaceAll("<", "\\u003c");
  const resizeReload = String(metadata.description || "").includes("github.com/codrops/RainEffect");
  const script = parseFragment(`<script>(${bootstrap.toString()})(${config},${resizeReload});</script>`).childNodes[0];
  if (head) { head.childNodes.unshift(script); script.parentNode = head; }
  return serialize(document);
}

export function webWallpaperHeaders(origin: string, id: string, token: string) {
  const prefix = `${origin}/api/wallpapers/${id}/web-assets/${token}/`;
  return new Headers({
    "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${prefix} blob:; style-src 'unsafe-inline' ${prefix}; img-src ${prefix} data: blob:; media-src ${prefix} data: blob:; font-src ${prefix} data:; connect-src ${prefix}; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range, Content-Type",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=()",
  });
}
