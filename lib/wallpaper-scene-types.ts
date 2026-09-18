export type SceneValues = Record<string, unknown>;
export interface ScenePropertyScript { property: string; source: string; properties: SceneValues }
export interface SceneTimelineKey {
  frame: number; value: number; step: boolean;
  front?: [number, number]; back?: [number, number];
}
export interface SceneTimeline {
  property: string; name: string; fps: number; frames: number;
  mode: "loop" | "single" | "mirror"; startPaused: boolean; wrapLoop: boolean;
  relative: boolean; base: number[]; channels: SceneTimelineKey[][];
}
export interface SceneFont { key: string; url: string; mimeType: string }
export interface SceneSound {
  id: number; name?: string; files: { key: string; url: string; mimeType: string }[];
  volume: number; mode: "loop" | "single" | "random"; startSilent: boolean;
  minTime: number; maxTime: number;
}
export type SceneSoundCommand = { id: number; action: "play" | "pause" | "stop" | "volume"; value?: number };
export interface SceneMesh {
  positions: number[]; uvs: number[]; indices: number[];
  joints?: number[]; weights?: number[];
  bones?: { parent: number; matrix: number[]; name?: string; physics?: boolean }[];
  referencePose?: number[][];
  editedPose?: number[][];
  editedPositions?: number[];
  clips?: { texture: string; bonePath: number[]; target: number; vertices: number[] }[];
  attachments?: { name: string; bone: number; matrix: number[] }[];
  animations?: { id: number; fps: number; frames: number; mode: string; tracks: { bone: number; values: number[] }[]; opacity?: number[][] }[];
  playback?: { id: number; rate: number; blend: number; additive?: boolean };
  playbacks?: NonNullable<SceneMesh["playback"]>[];
}
export interface SceneText {
  value: string; script?: string; properties: SceneValues; font: string;
  pointSize: number; padding: number; horizontal: "left" | "center" | "right";
  vertical: "top" | "center" | "bottom"; background?: number[];
  maxWidth?: number; maxRows?: number; ellipsis?: boolean;
}
export interface SceneTexture { key: string; url: string; mimeType?: string; width: number; height: number; format: number; frames: { x: number; y: number; width: number; height: number; duration: number; axes?: number[] }[]; }
export interface ScenePass {
  vertex: string; fragment: string; uniforms: Record<string, number | number[]>;
  scripts?: ScenePropertyScript[];
  textures: (string | null)[]; repeats: number[];
  inputs?: Record<number, number>;
  scale?: number;
}
export interface SceneLayer {
  id: number; name: string; origin: number[]; scale: number[]; angle: number;
  size: number[]; color: number[]; alpha: number; texture: string; blending: string;
  passes: ScenePass[];
  parallax: number[]; colorBlendMode: number;
  text?: SceneText;
  reflection?: { normal: string; roughness: number; metallic: number; reflectivity: number };
  mesh?: SceneMesh;
  scripts?: ScenePropertyScript[];
  visible?: boolean;
  solid?: boolean;
  disablePropagation?: boolean;
  timelines?: SceneTimeline[];
  group?: boolean;
  alignment?: string;
  parent?: number;
  attachment?: string;
  parallaxInherited?: boolean;
}
export interface SceneParticles {
  id: number; origin: number[]; scale: number[]; angle: number;
  texture: string; blending: string; config: SceneValues; overrides: SceneValues;
  parallax: number[]; children: SceneParticles[];
  event?: { type: "static" | "eventfollow" | "eventspawn" | "eventdeath"; max: number; probability: number; origin: number[]; scale: number[]; angle: number };
  refraction?: { texture?: string; amount: number };
  overbright?: number;
}
export interface BrowserScene {
  version: 1; width: number; height: number; clearColor: number[];
  layers: SceneLayer[]; particles: SceneParticles[]; textures: SceneTexture[];
  fonts?: SceneFont[];
  sounds?: SceneSound[];
  scriptTemplates?: Record<string, SceneLayer>;
  warnings?: string[];
  cameraEffects: { parallax: boolean; amount: number; delay: number; mouse: number; shake: boolean; amplitude: number; speed: number; roughness: number };
  bloom?: { strength: number; threshold: number };
}
