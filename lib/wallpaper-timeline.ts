import type { SceneTimeline, SceneTimelineKey } from "./wallpaper-scene-types";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown) => {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e6) throw new Error("Invalid timeline number");
  return v;
};

export function parseSceneTimeline(property: string, source: unknown, saved: unknown): SceneTimeline {
  const dimensions: Record<string, number> = { alpha: 1, origin: 3, scale: 3, angles: 3, color: 3, parallaxDepth: 2 };
  const count = dimensions[property], data = record(source), options = record(data.options);
  if (!count || Object.keys(data).some(k => !["options", "relative", ...Array.from({ length: count }, (_, i) => `c${i}`)].includes(k)) || Object.keys(options).some(k => !["fps", "length", "mode", "name", "startpaused", "wraploop"].includes(k))) throw new Error("Unsupported timeline options");
  const fps = finite(options.fps ?? 30), frames = finite(options.length ?? 60), mode = options.mode ?? "loop";
  if (fps <= 0 || fps > 1000 || frames < 1 || !Number.isInteger(frames) || !["loop", "single", "mirror"].includes(String(mode))) throw new Error("Invalid timeline duration or mode");
  const name = options.name ?? "";
  if (typeof name !== "string" || name.length > 256) throw new Error("Invalid timeline name");
  const unit = property === "angles" ? 180 / Math.PI : 1;
  const values = count === 1 ? [saved] : typeof saved === "string" ? saved.trim().split(/\s+/).map(Number) : saved;
  if (!Array.isArray(values) || values.length !== count) throw new Error("Invalid timeline base value");
  const base = values.map(v => finite(finite(v) * unit));
  const handle = (value: unknown): [number, number] | undefined => {
    const h = record(value);
    if (!h.enabled) return undefined;
    return [finite(h.x), finite(finite(h.y) * unit)];
  };
  const channels = Array.from({ length: count }, (_, i) => {
    const keys = data[`c${i}`];
    if (!Array.isArray(keys) || !keys.length || keys.length > 2048) throw new Error("Invalid timeline channel");
    let previous = -1;
    return keys.map(value => {
      const key = record(value), frame = finite(key.frame);
      if (frame < 0 || frame > frames || frame <= previous) throw new Error("Invalid timeline key order");
      previous = frame;
      return { frame, value: finite(finite(key.value) * unit), step: key.step === true, front: handle(key.front), back: handle(key.back) };
    });
  });
  return { property, name, fps, frames, mode: mode as SceneTimeline["mode"], startPaused: options.startpaused === true, wrapLoop: options.wraploop === true, relative: data.relative === true, base, channels };
}

// Exported WE curves store X tangents in half-segment units and Y as offsets.
// The editor precomputes "magic" handles; runtime evaluation uses those values.
export function sampleSceneTimeline(keys: SceneTimelineKey[], frame: number, length: number, wrap: boolean): number {
  const first = keys[0], last = keys[keys.length - 1];
  if (frame <= first.frame) return first.value;
  let left = last, right: SceneTimelineKey | undefined;
  if (frame < last.frame) {
    let lo = 0, hi = keys.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].frame <= frame) lo = mid; else hi = mid; }
    left = keys[lo]; right = keys[hi];
  } else if (wrap && last.frame < length) {
    right = { ...first, frame: length, back: first.front ? [-first.front[0], -first.front[1]] : undefined };
  }
  if (!right) return last.value;
  if (frame >= right.frame) return right.value;
  if (right.step) return left.value;
  const x = (frame - left.frame) / (right.frame - left.frame);
  if (!left.front && !right.back) return left.value + (right.value - left.value) * x;
  const x1 = Math.max(0, Math.min(1, (left.front?.[0] ?? 0) / 2));
  const x2 = Math.max(0, Math.min(1, 1 + (right.back?.[0] ?? 0) / 2));
  const bezier = (t: number, a: number, b: number, c: number, d: number) => (1-t)**3*a + 3*(1-t)**2*t*b + 3*(1-t)*t*t*c + t**3*d;
  let low = 0, high = 1;
  for (let i = 0; i < 28; i++) { const mid = (low + high) / 2; if (bezier(mid, 0, x1, x2, 1) < x) low = mid; else high = mid; }
  return bezier((low + high) / 2, left.value, left.value + (left.front?.[1] ?? 0), right.value + (right.back?.[1] ?? 0), right.value);
}

// Runs inside the same bounded QuickJS VM as the property scripts.
export const timelineGuestSource = String.raw`(function(finite,sample){
  const entries=[];
  function create(definitions,apply){
    return (definitions??[]).map(def=>{
      const state={frame:0,phase:0,rate:1,playing:!def.startPaused};
      const evaluate=()=>apply(def.property,def.channels.map((keys,i)=>(def.relative?def.base[i]:0)+sample(keys,state.frame,def.frames,def.wrapLoop&&def.mode==='loop')));
      const api=Object.freeze({
        get fps(){return def.fps;},get frameCount(){return def.frames;},get duration(){return def.frames/def.fps;},get name(){return def.name;},
        get rate(){return state.rate;},set rate(v){state.rate=finite(v);},
        play(){if(!state.playing&&def.mode==='single'&&(state.rate>=0?state.frame>=def.frames:state.frame<=0)){state.frame=state.rate>=0?0:def.frames;state.phase=state.frame;}state.playing=true;},
        pause(){state.playing=false;},stop(){state.playing=false;state.frame=state.phase=0;evaluate();},isPlaying(){return state.playing;},
        getFrame(){return state.frame;},setFrame(v){state.frame=state.phase=Math.max(0,Math.min(def.frames,finite(v)));evaluate();}
      });
      const entry={def,state,api,evaluate};entries.push(entry);return entry;
    });
  }
  function advance(dt){
    for(const {def,state,evaluate} of entries){
      if(state.playing){
        state.phase+=dt*def.fps*state.rate;
        if(def.mode==='single'){
          state.frame=Math.max(0,Math.min(def.frames,state.phase));
          if(Math.abs(state.frame-def.frames)<1e-7)state.frame=def.frames;
          if(Math.abs(state.frame)<1e-7)state.frame=0;
          state.phase=state.frame;
          if(state.rate>0&&state.frame>=def.frames||state.rate<0&&state.frame<=0)state.playing=false;
        }else{
          const period=def.frames*(def.mode==='mirror'?2:1);state.phase=((state.phase%period)+period)%period;
          state.frame=def.mode==='mirror'&&state.phase>def.frames?period-state.phase:state.phase;
        }
      }
      evaluate();
    }
  }
  return {create,advance};
})`;
