import { resourceName } from "./wallpaper-binary";
import type { SceneMesh } from "./wallpaper-scene-types";

// Byte-counted geometry followed by bounded skeleton, attachment and animation sections.
export function decodeSceneMesh(bytes: Buffer): SceneMesh {
  let offset = 0;
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Scene mesh exceeds size limit");
  const take = (length: number) => {
    if (!Number.isInteger(length) || length < 0 || length > bytes.length - offset) throw new Error("Truncated scene mesh");
    const start = offset; offset += length; return start;
  };
  const uint = () => bytes.readUInt32LE(take(4));
  const ushort = () => bytes.readUInt16LE(take(2));
  const flag = () => { const value = bytes[take(1)]; if (value > 1) throw new Error("Invalid scene mesh flag"); return value === 1; };
  const zeros = (length: number) => { const start = take(length); if (bytes.subarray(start, start + length).some(n => n !== 0)) throw new Error("Unsupported scene mesh metadata"); };
  const float = () => { const value = bytes.readFloatLE(take(4)); if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error("Invalid scene mesh coordinate"); return value; };
  const string = () => {
    const end = bytes.indexOf(0, offset);
    if (end < offset || end - offset > 4096) throw new Error("Invalid scene mesh string");
    const value = bytes.toString("utf8", offset, end); take(end - offset + 1); return value;
  };
  const version = string(), layout = uint();
  const skinned = layout === 0x1800009;
  const newest = version === "MDLV0023", modern = version === "MDLV0019" || newest;
  if (version !== "MDLV0013" && !modern || layout !== 9 && !skinned || modern && !skinned) throw new Error(`Animated or unsupported scene mesh layout: ${version}/${layout}`);
  if (uint() !== 1 || uint() !== 1) throw new Error("Multi-part scene meshes are not supported yet");
  resourceName(string());
  const meshFlags = uint();
  if (meshFlags !== 0 && !(newest && meshFlags === 4)) throw new Error("Unsupported scene mesh flags");
  if (modern) { zeros(24); if (uint() !== 0x180000f) throw new Error("Unsupported scene vertex layout"); }
  const vertexBytes = uint();
  const stride = modern ? 80 : skinned ? 52 : 20;
  if (!vertexBytes || vertexBytes % stride || vertexBytes / stride > (skinned ? 10000 : 65536)) throw new Error("Invalid scene mesh vertex count");
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const joints: number[] = [], weights: number[] = [];
  for (let i = 0; i < vertexBytes / stride; i++) {
    positions.push(float(), float(), float());
    if (modern) for (let component = 0; component < 7; component++) float(); // Normal and tangent are unused by unlit image materials.
    if (skinned) { joints.push(uint(), uint(), uint(), uint()); weights.push(float(), float(), float(), float()); }
    uvs.push(float(), float());
  }
  const indexBytes = uint();
  if (!indexBytes || indexBytes % 6 || indexBytes > 2 * 1024 * 1024) throw new Error("Invalid scene mesh triangles");
  for (let i = 0; i < indexBytes / 2; i++) {
    const index = bytes.readUInt16LE(take(2));
    if (index >= positions.length / 3) throw new Error("Scene mesh index out of bounds");
    indices.push(index);
  }
  const mesh: SceneMesh = { positions, uvs, indices };
  const groups: { bone: number; start: number; count: number }[] = [];
  const clips: { texture: string; bonePath: number[]; target: number; vertices: number[] }[] = [];
  if (newest) {
    if (flag()) {
      if(uint()!==1||uint()!==positions.length*4)throw new Error("Unsupported alternate scene vertex layout");
      mesh.editedPositions=Array.from({length:positions.length},float);
    }
    if (flag()) {
      const length=uint();
      if(length%16||length>64*16)throw new Error("Invalid scene mesh groups");
      for(let i=0;i<length/16;i++) {
        const bone=uint();if(uint()!==0)throw new Error("Unsupported scene mesh group flags");
        const start=uint(),count=uint();
        if(start%3||count%3||start+count>indices.length)throw new Error("Invalid scene mesh group range");
        groups.push({bone,start,count});
      }
      let end=0;
      for(const group of groups.filter(g=>g.count).sort((a,b)=>a.start-b.start)){if(group.start!==end)throw new Error("Overlapping scene mesh groups");end+=group.count;}
      if(end!==indices.length)throw new Error("Incomplete scene mesh groups");
    }
    const clipCount=uint();
    if(clipCount>4)throw new Error("Too many puppet clipping masks");
    for(let i=0;i<clipCount;i++) {
      uint();if(uint()!==0)throw new Error("Unsupported puppet clipping flags");
      const texture=resourceName(string());
      if(uint()!==0||uint()!==1)throw new Error("Unsupported puppet clipping layout");
      const target=uint(),length=uint();
      if(!length||length>64||clips.some(c=>c.target===target))throw new Error("Invalid puppet clipping path");
      const bonePath=Array.from({length},uint),group=groups.find(g=>g.bone===target);
      if(!group)throw new Error("Missing puppet clipping group");
      clips.push({texture,bonePath,target,vertices:[...new Set(indices.slice(group.start,group.start+group.count))]});
    }
    if(clips.length)mesh.clips=clips;
  }
  if (skinned) {
    if (string() !== (newest ? "MDLS0004" : modern ? "MDLS0002" : "MDLS0001")) throw new Error("Unsupported scene skeleton version");
    const skeletonEnd = uint(), count = uint();
    if (!count || count > 64 || skeletonEnd > bytes.length) throw new Error("Invalid scene skeleton size");
    const bones: NonNullable<SceneMesh["bones"]> = [];
    if(groups.some(g=>g.bone>=count))throw new Error("Scene group bone out of bounds");
    let boneOrder=Array.from({length:count},(_,i)=>i),depthOrder:number[]|undefined;
    for (let i = 0; i < count; i++) {
      const name = string(), type = uint();
      if (type > 1 || !modern && type !== 1) throw new Error("Unsupported scene bone type");
      const parent = bytes.readInt32LE(take(4));
      if (parent < -1 || parent >= count || parent === i || uint() !== 64) throw new Error("Invalid scene bone transform");
      const matrix = Array.from({ length: 16 }, float), metadata = string();
      const settings = modern && metadata ? JSON.parse(metadata) as Record<string, unknown> : {};
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid bone settings");
      bones.push({ parent, matrix, ...(name ? { name } : {}), ...(settings.se === true ? { physics: true } : {}) });
    }
    for(const clip of clips)if(clip.bonePath.some((bone,i)=>bone>=count||bones[bone].parent!==(i?clip.bonePath[i-1]:-1)))throw new Error("Invalid puppet clipping hierarchy");
    if (modern) {
      zeros(2);
      if (flag()) mesh.referencePose = Array.from({ length: count }, () => Array.from({ length: 16 }, float));
      zeros(8);
      if (flag()) for (let i = 0; i < count * 19; i++) float(); // Editor bone bounds, not vertex transforms.
      if (flag()) {
        const order = new Set<number>();
        for (let i = 0; i < count; i++) { const bone = uint(); if (bone >= count || order.has(bone)) throw new Error("Invalid scene bone ordering"); order.add(bone); }
        boneOrder=[...order];
      }
      if(newest&&flag())depthOrder=Array.from({length:count},()=>bytes.readInt32LE(take(4)));
    }
    if (offset !== skeletonEnd) throw new Error("Invalid scene skeleton section boundary");
    for (let i = 0; i < count; i++) {
      const visited = new Set<number>(); let parent = i;
      while (parent !== -1) { if (visited.has(parent)) throw new Error("Cyclic scene skeleton"); visited.add(parent); parent = bones[parent].parent; }
    }
    for (let i = 0; i < weights.length; i += 4) {
      const sum = weights.slice(i, i + 4).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > .01) throw new Error("Invalid scene skin weights");
      for (let j = i; j < i + 4; j++) if (weights[j] < 0 || weights[j] > 1.001 || joints[j] >= count && weights[j] > 0) throw new Error("Invalid scene skin joint");
    }
    mesh.joints = joints; mesh.weights = weights; mesh.bones = bones;
    if(groups.length) {
      const rank=new Map(boneOrder.map((bone,i)=>[bone,depthOrder?.[bone]??i]));
      mesh.indices=groups.sort((a,b)=>rank.get(a.bone)!-rank.get(b.bone)!).flatMap(g=>indices.slice(g.start,g.start+g.count));
    }
    if (modern && bytes.toString("ascii", offset, offset + 8) === "MDAT0001") {
      string(); const end = uint(), attachments = ushort();
      if (attachments > 128 || end > bytes.length) throw new Error("Invalid scene attachment section");
      mesh.attachments = [];
      for (let i = 0; i < attachments; i++) {
        const bone = ushort(), name = string();
        if (bone >= count || !name || mesh.attachments.some(a => a.name === name)) throw new Error("Invalid scene attachment");
        mesh.attachments.push({ bone, name, matrix: Array.from({ length: 16 }, float) });
      }
      if (offset !== end) throw new Error("Invalid scene attachment section boundary");
    }
    if (modern && (offset === bytes.length || bytes.subarray(offset).every(n => n === 0))) {
      if(clips.length)throw new Error("Missing puppet clipping reference pose");
      return mesh;
    }
    if (string() !== (newest ? "MDLA0006" : modern ? "MDLA0005" : "MDLA0001")) throw new Error("Unsupported scene animation version");
    const animationEnd = uint(), animationCount = uint();
    if (animationEnd > bytes.length || animationCount > 16) throw new Error("Invalid scene animation count");
    mesh.animations = [];
    let samples = 0;
    for (let i = 0; i < animationCount; i++) {
      const id = uint();
      if (uint() !== 0) throw new Error("Unsupported scene animation flags");
      string(); const mode = string(), fps = float(), frames = uint();
      if (!["loop", "once"].includes(mode) || fps <= 0 || fps > 1000 || !frames || frames > 100000 || uint() !== 0) throw new Error("Unsupported scene animation timing");
      const trackCount = uint(), tracks: NonNullable<SceneMesh["animations"]>[number]["tracks"] = [];
      if (trackCount !== count) throw new Error("Invalid scene animation track count");
      for (let track = 0; track < trackCount; track++) {
        const flags = uint(), length = uint(); samples += length / 4;
        if (flags !== 0 || length !== (frames + 1) * 36 || samples > 2 * 1024 * 1024) throw new Error("Invalid scene animation track");
        tracks.push({ bone: track, values: Array.from({ length: length / 4 }, float) });
      }
      if (uint() !== 0) throw new Error("Scene animation events are not supported yet");
      const opacity: number[][]=[];
      if(newest&&flag())for(let bone=0;bone<count;bone++) {
        const flags=uint(),length=uint();samples+=length/4;
        if(flags!==0||length!==(frames+1)*4||samples>2*1024*1024)throw new Error("Invalid bone opacity track");
        const values=Array.from({length:frames+1},float);
        if(values.some(v=>v<0||v>1))throw new Error("Invalid bone opacity value");
        opacity.push(values);
      }
      if (modern) zeros(30);
      mesh.animations.push({ id, fps, frames, mode, tracks, ...(opacity.length?{opacity}:{}) });
    }
    if (offset !== animationEnd) throw new Error("Invalid scene animation section boundary");
    if (newest && bytes.toString("ascii",offset,offset+8)==="MDLE0002") {
      string();const end=uint(),length=uint();
      if(length!==count*64||end!==offset+length||end>bytes.length)throw new Error("Invalid edited scene pose");
      mesh.editedPose=Array.from({length:count},()=>Array.from({length:16},float));
    }
    if(clips.length&&!mesh.editedPose)throw new Error("Missing puppet clipping reference pose");
  }
  if (bytes.subarray(offset).some(value => value !== 0)) throw new Error("Scene mesh contains unsupported skeletal or animation data");
  return mesh;
}
