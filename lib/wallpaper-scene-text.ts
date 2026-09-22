import { CanvasTexture, LinearFilter, NoColorSpace } from "three";
import { SceneTextScript } from "./wallpaper-scene-script";
import type { SceneLayer } from "./wallpaper-scene-types";
import { sceneTextLines } from "./wallpaper-text-layout";
import { MIN_TEXT_SCRIPT_BUDGET_MS } from "./wallpaper-text-scheduler";

export class SceneTextTexture {
  readonly canvas = document.createElement("canvas");
  readonly texture = new CanvasTexture(this.canvas);
  warning?: string;
  private context: CanvasRenderingContext2D;
  private script?: SceneTextScript;
  private previous?: string;
  private value: string;
  private nextUpdate = 0;
  private constructor(private layer: SceneLayer, private family: string, maxTextureSize: number) {
    const [w, h] = layer.size;
    const scale = Math.min(2, maxTextureSize / w, maxTextureSize / h, Math.sqrt(4 * 1024 * 1024 / (w * h)));
    this.canvas.width = Math.max(1, Math.ceil(w * scale)); this.canvas.height = Math.max(1, Math.ceil(h * scale));
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Cannot create scene text canvas");
    this.context = context;
    this.texture.flipY = false; this.texture.colorSpace = NoColorSpace;
    this.texture.minFilter = this.texture.magFilter = LinearFilter; this.texture.generateMipmaps = false;
    this.value = layer.text!.value;
  }
  static async create(layer: SceneLayer, family: string, maxTextureSize: number) {
    const result = new SceneTextTexture(layer, family, maxTextureSize);
    try {
      if (layer.text!.script) {
        try { result.script = await SceneTextScript.create(layer.text!); }
        catch { result.disableScript(); }
      }
      result.update(0);
      return result;
    } catch (e) { result.dispose(); throw e; }
  }
  update(time: number, now = Date.now(), budgetMs = 8) {
    if (this.previous !== undefined && (!this.script || time < this.nextUpdate)) return;
    if (this.script && (!Number.isFinite(budgetMs) || budgetMs < MIN_TEXT_SCRIPT_BUDGET_MS)) return;
    this.nextUpdate = time + .05;
    if (this.script) {
      try { this.value = this.script.update(this.value, now, budgetMs); }
      catch { this.disableScript(); }
    }
    if (this.previous === this.value) return;
    this.previous = this.value;
    const c = this.context, text = this.layer.text!, [w, h] = this.layer.size;
    c.setTransform(this.canvas.width / w, 0, 0, this.canvas.height / h, 0, 0);
    c.clearRect(0, 0, w, h);
    if (text.background) { c.fillStyle = `rgb(${text.background.map(n => Math.round(n * 255)).join(" ")})`; c.fillRect(0, 0, w, h); }
    c.font = `${text.pointSize * 96 / 72}px ${this.family}`;
    c.fillStyle = "white"; c.textAlign = text.horizontal; c.textBaseline = "alphabetic";
    const metrics = c.measureText("Mg"), ascent = metrics.fontBoundingBoxAscent || text.pointSize * 96 / 72;
    const descent = metrics.fontBoundingBoxDescent || text.pointSize / 3, lineHeight = ascent + descent;
    const lines = sceneTextLines(this.value, line => c.measureText(line).width, text.maxWidth, text.maxRows, text.ellipsis), total = lines.length * lineHeight;
    const x = text.horizontal === "left" ? text.padding : text.horizontal === "right" ? w - text.padding : w / 2;
    const y = (text.vertical === "top" ? text.padding : text.vertical === "bottom" ? h - text.padding - total : (h - total) / 2) + ascent;
    lines.forEach((line, i) => c.fillText(line, x, y + i * lineHeight));
    this.texture.needsUpdate = true;
  }
  private disableScript() {
    this.script?.dispose(); this.script = undefined;
    this.warning = `SceneScript text disabled after an unsupported API, invalid value, or execution limit: layer ${this.layer.id}; last valid text retained`;
  }
  dispose() { this.script?.dispose(); this.texture.dispose(); this.canvas.width = this.canvas.height = 1; }
}
