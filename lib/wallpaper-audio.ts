import type { SceneSound, SceneSoundCommand } from "./wallpaper-scene-types";

export type WallpaperAudioSettings = { volume: number; muted: boolean; paused: boolean };
export type WallpaperAudioState = { blocked: boolean; capturing: boolean; error: string };
const initial: WallpaperAudioState = { blocked: false, capturing: false, error: "" };
let state = initial;
let active: WallpaperAudio | undefined;
const listeners = new Set<() => void>();
export const subscribeWallpaperAudio = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const wallpaperAudioState = () => state;
export const serverWallpaperAudioState = () => initial;
export function activateWallpaperAudio(audio: WallpaperAudio) { active = audio; publish(audio); }
function publish(audio: WallpaperAudio) {
  if (active !== audio) return;
  state = { ...audio.state }; listeners.forEach(fn => fn());
}
export async function toggleWallpaperAudioCapture() {
  if (!active) throw new Error("Select a scene wallpaper first");
  if (active.state.capturing) active.stopCapture(); else await active.startCapture();
}

// Log-frequency bands, low to high; native SceneScript expects 64 bins per ear.
export function spectrumBands(bins: Uint8Array, sampleRate: number, fftSize: number): number[] {
  const result = Array<number>(64).fill(0), high = Math.min(20000, sampleRate / 2);
  for (let band = 0; band < 64; band++) {
    const lo = Math.max(1, Math.floor(20 * (high / 20) ** (band / 64) * fftSize / sampleRate));
    const hi = Math.min(bins.length, Math.max(lo + 1, Math.ceil(20 * (high / 20) ** ((band + 1) / 64) * fftSize / sampleRate)));
    for (let i = lo; i < hi; i++) result[band] = Math.max(result[band], bins[i] / 255);
  }
  return result;
}
export function audioUniformSpectrum(name: string, stereo: readonly number[]) {
  const match = /^g_AudioSpectrum(16|32|64)(Left|Right)?$/.exec(name);
  if (!match) return undefined;
  const size = Number(match[1]), stride = 64 / size;
  return Array.from({ length: size }, (_, i) => {
    let value = 0;
    for (let n = 0; n < stride; n++) {
      const k = i * stride + n, left = stereo[k] || 0, right = stereo[k + 64] || 0;
      value += match[2] === "Left" ? left : match[2] === "Right" ? right : (left + right) / 2;
    }
    return value / stride;
  });
}

type Track = { media: HTMLMediaElement; owned: boolean; sound?: SceneSound; enabled: boolean; volume: number; gain?: GainNode; index: number; timer?: ReturnType<typeof setTimeout>; failed: boolean; ended: () => void; error: () => void };
export class WallpaperAudio {
  readonly state: WallpaperAudioState = { ...initial };
  private context?: AudioContext;
  private mix?: GainNode;
  private master?: GainNode;
  private analysers?: AnalyserNode[];
  private capture?: { stream: MediaStream; source: MediaStreamAudioSourceNode; splitter: ChannelSplitterNode; analysers: AnalyserNode[] };
  private capturePending = false;
  private disposed = false;
  private playing = false;
  private tracks: Track[] = [];
  private bins = new Uint8Array(1024);
  private zeros = Array<number>(128).fill(0);
  private settings: WallpaperAudioSettings;
  constructor(sounds: SceneSound[], settings: WallpaperAudioSettings, media?: HTMLMediaElement) {
    this.settings = settings;
    for (const sound of sounds) {
      const el = new Audio(); el.preload = "auto"; el.src = sound.files[0].url;
      this.add(el, true, sound);
    }
    if (media) this.add(media, false);
    document.addEventListener("visibilitychange", this.sync);
    window.addEventListener("pointerdown", this.unlock, true);
    window.addEventListener("keydown", this.unlock, true);
    this.sync();
  }
  private ensureContext() {
    if (this.context) return this.context;
    const ctx = this.context = new AudioContext();
    this.mix = ctx.createGain(); this.master = ctx.createGain();
    this.mix.channelCount = 2; this.mix.channelCountMode = "explicit";
    this.mix.connect(this.master); this.master.connect(ctx.destination);
    const splitter = ctx.createChannelSplitter(2); this.mix.connect(splitter);
    this.analysers = this.makeAnalysers(splitter);
    for (const track of this.tracks) this.connect(track);
    this.applyVolume();
    return ctx;
  }
  private makeAnalysers(splitter: ChannelSplitterNode) {
    return [0, 1].map(channel => { const a = this.context!.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = .7; splitter.connect(a, channel); return a; });
  }
  private connect(track: Track) {
    const source = this.context!.createMediaElementSource(track.media), gain = this.context!.createGain();
    track.gain = gain; gain.gain.value = track.volume; source.connect(gain); gain.connect(this.mix!);
    track.media.volume = 1; track.media.muted = false;
  }
  private add(media: HTMLMediaElement, owned: boolean, sound?: SceneSound) {
    const track: Track = { media, owned, sound, enabled: !sound?.startSilent, volume: sound?.volume ?? 1, index: 0, failed: false, ended: () => {
      if (!sound || !track.enabled || sound.mode === "single" || this.disposed) return;
      const advance = () => {
        track.timer = undefined;
        track.index = (track.index + 1) % sound.files.length;
        media.src = sound.files[track.index].url;
        if (this.playing) void this.play(track);
      };
      if (sound.mode === "random") track.timer = setTimeout(advance, 1000 * (sound.minTime + Math.random() * (sound.maxTime - sound.minTime)));
      else advance();
    }, error: () => { track.failed = true; this.state.error = "Wallpaper audio could not be decoded or loaded"; publish(this); } };
    media.loop = !sound || (sound.mode === "loop" && sound.files.length === 1);
    media.addEventListener("ended", track.ended); media.addEventListener("error", track.error);
    this.tracks.push(track);
  }
  private async play(track: Track) {
    if (track.failed || !track.enabled || track.timer || (track.sound?.mode === "single" && track.media.ended)) return;
    try { await track.media.play(); }
    catch (e) {
      if (this.disposed || !this.playing || (e as Error).name === "AbortError") return;
      if ((e as Error).name === "NotAllowedError") this.state.blocked = true;
      else { track.failed = true; this.state.error = `Wallpaper audio: ${(e as Error).message}`; }
      publish(this);
    }
  }
  private unlock = () => { if (this.state.blocked || this.context?.state === "suspended") this.sync(); };
  private sync = () => {
    if (this.disposed) return;
    this.playing = !this.settings.paused && !document.hidden;
    if (!this.playing) { this.tracks.forEach(t => t.media.pause()); void this.context?.suspend(); return; }
    if (!this.tracks.length && !this.capture) return;
    const ctx = this.ensureContext();
    this.state.blocked = ctx.state !== "running"; publish(this);
    void ctx.resume().then(() => {
      if (this.disposed) return;
      if (!this.playing) { void ctx.suspend(); return; }
      this.state.blocked = false; publish(this);
    }).catch(() => { this.state.blocked = true; publish(this); });
    this.tracks.forEach(t => { void this.play(t); });
  };
  private applyVolume() { if (this.master) this.master.gain.value = this.settings.muted ? 0 : this.settings.volume / 100; }
  configure(settings: WallpaperAudioSettings) {
    const changed = settings.paused !== this.settings.paused;
    this.settings = settings; this.applyVolume(); if (changed) this.sync();
  }
  get hasSource() { return !!this.capture || this.tracks.some(t => !t.failed && t.enabled); }
  soundStates() { return this.tracks.filter(t => t.sound).map(t => ({ id: t.sound!.id, playing: !t.media.paused && !t.media.ended && !t.failed, volume: t.volume })); }
  command(command: SceneSoundCommand) {
    if (this.disposed) return;
    const track = this.tracks.find(t => t.sound?.id === command.id);
    if (!track) throw new Error("Scene sound is unavailable");
    if (command.action === "volume") {
      if (!Number.isFinite(command.value) || command.value! < 0 || command.value! > 1) throw new Error("Invalid sound volume");
      track.volume = command.value!; if (track.gain) track.gain.gain.value = track.volume;
    } else if (command.action === "play") {
      if (track.media.ended) { track.index = (track.index + 1) % track.sound!.files.length; track.media.src = track.sound!.files[track.index].url; track.media.currentTime = 0; }
      track.enabled = true; this.sync();
    } else if (command.action === "pause" || command.action === "stop") {
      track.enabled = false; clearTimeout(track.timer); track.timer = undefined; track.media.pause();
      if (command.action === "stop") track.media.currentTime = 0;
    } else throw new Error("Invalid sound action");
  }
  spectrum(): number[] {
    if (!this.playing || this.context?.state !== "running") return this.zeros;
    const analysers = this.capture?.analysers || this.analysers;
    if (!analysers) return this.zeros;
    return analysers.flatMap(a => { a.getByteFrequencyData(this.bins); return spectrumBands(this.bins, this.context!.sampleRate, a.fftSize); });
  }
  async startCapture() {
    if (this.capturePending || this.disposed) return;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("System audio capture requires HTTPS or localhost and a supported desktop browser");
    this.capturePending = true;
    try {
      const ctx = this.ensureContext(); void ctx.resume().catch(() => {});
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include" } as DisplayMediaStreamOptions);
      if (this.disposed || !stream.getAudioTracks().length) {
        stream.getTracks().forEach(t => t.stop());
        if (!this.disposed) throw new Error("No audio was shared. Enable audio in the browser sharing dialog.");
        return;
      }
      this.stopCapture();
      // Only audio reaches Web Audio; no captured image is read, rendered or sent.
      stream.getVideoTracks().forEach(t => { t.enabled = false; });
      const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())), splitter = ctx.createChannelSplitter(2);
      source.connect(splitter);
      this.capture = { stream, source, splitter, analysers: this.makeAnalysers(splitter) };
      stream.getTracks().forEach(t => t.addEventListener("ended", () => this.stopCapture(), { once: true }));
      this.state.capturing = true; publish(this); this.sync();
    } finally { this.capturePending = false; }
  }
  stopCapture() {
    const capture = this.capture; this.capture = undefined;
    capture?.stream.getTracks().forEach(t => t.stop()); capture?.source.disconnect(); capture?.splitter.disconnect();
    capture?.analysers.forEach(a => a.disconnect());
    this.state.capturing = false; publish(this);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.stopCapture();
    document.removeEventListener("visibilitychange", this.sync);
    window.removeEventListener("pointerdown", this.unlock, true); window.removeEventListener("keydown", this.unlock, true);
    for (const t of this.tracks) {
      clearTimeout(t.timer); t.media.pause(); t.media.removeEventListener("ended", t.ended); t.media.removeEventListener("error", t.error);
      if (t.owned) { t.media.removeAttribute("src"); t.media.load(); }
    }
    void this.context?.close();
    if (active === this) { active = undefined; state = initial; listeners.forEach(fn => fn()); }
  }
}
