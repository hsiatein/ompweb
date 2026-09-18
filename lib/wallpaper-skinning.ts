import { Bone, Euler, Matrix4, Quaternion, Skeleton, Vector3 } from "three";
import type { SceneMesh } from "./wallpaper-scene-types";

export class SceneMeshAnimator {
  readonly positions: Float32Array;
  readonly opacities: Float32Array;
  private skeleton: Skeleton;
  private rest: { position: Vector3; quaternion: Quaternion; scale: Vector3 }[];
  private a = new Quaternion();
  private b = new Quaternion();
  private delta = new Quaternion();
  private samplePosition = new Vector3();
  private sampleScale = new Vector3();
  private euler = new Euler();
  private time = NaN;
  private boneOpacity: number[];
  private attachmentTransforms = new Map<string, { bone: number; local: Matrix4; result: Matrix4 }>();
  private clippingTransforms: { bone: number; reference: Matrix4; result: Matrix4 }[] = [];
  constructor(private mesh: SceneMesh) {
    const bones = mesh.bones!.map(({ matrix }) => {
      const bone = new Bone(), transform = new Matrix4().fromArray(matrix);
      if (Math.abs(transform.determinant()) < 1e-12) throw new Error("Singular scene bind transform");
      transform.decompose(bone.position, bone.quaternion, bone.scale); return bone;
    });
    mesh.bones!.forEach(({ parent }, i) => { if (parent >= 0) bones[parent].add(bones[i]); });
    for (const bone of bones) if (!bone.parent) bone.updateMatrixWorld(true);
    this.skeleton = new Skeleton(bones);
    // Bind inverses refer to the separated texture sheet. Animation starts from
    // the assembled reference pose, which may differ from the bind transforms.
    mesh.referencePose?.forEach((matrix, i) => {
      const transform = new Matrix4().fromArray(matrix);
      if (Math.abs(transform.determinant()) < 1e-12) throw new Error("Singular scene reference transform");
      transform.decompose(bones[i].position, bones[i].quaternion, bones[i].scale);
    });
    this.rest = bones.map(b => ({ position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone() }));
    this.positions = new Float32Array(mesh.positions);
    this.opacities = new Float32Array(mesh.positions.length/3).fill(1);
    this.boneOpacity=mesh.bones!.map(()=>1);
    for (const item of mesh.attachments || []) this.attachmentTransforms.set(item.name, { bone: item.bone, local: new Matrix4().fromArray(item.matrix), result: new Matrix4() });
    for (const clip of mesh.clips || []) {
      const reference = new Matrix4();
      for (const bone of clip.bonePath) {
        if (!mesh.editedPose?.[bone]) throw new Error("Missing clipping reference transform");
        reference.multiply(new Matrix4().fromArray(mesh.editedPose[bone]));
      }
      if (Math.abs(reference.determinant()) < 1e-12) throw new Error("Singular clipping reference transform");
      this.clippingTransforms.push({ bone: clip.bonePath.at(-1)!, reference, result: new Matrix4() });
    }
  }
  clippingMatrix(index: number) {
    const clip = this.clippingTransforms[index], world = this.skeleton.bones[clip.bone].matrixWorld;
    if (Math.abs(world.determinant()) < 1e-12) throw new Error("Singular clipping transform");
    return clip.result.copy(world).invert().premultiply(clip.reference);
  }
  attachment(name: string) {
    const item = this.attachmentTransforms.get(name);
    if (!item) throw new Error(`Missing scene attachment: ${name}`);
    return item.result.multiplyMatrices(this.skeleton.bones[item.bone].matrixWorld, item.local).elements;
  }
  localTransforms() { return this.skeleton.bones.map(b => b.matrix.toArray()); }
  applyLocalTransforms(values: Record<string, number[]>) {
    for (const [index, elements] of Object.entries(values)) {
      const bone = this.skeleton.bones[Number(index)], matrix = new Matrix4().fromArray(elements);
      if (!bone || Math.abs(matrix.determinant()) < 1e-12) throw new Error("Invalid scripted bone transform");
      matrix.decompose(bone.position, bone.quaternion, bone.scale);
    }
    this.upload();
  }
  update(time: number) {
    if (this.time === time) return false;
    this.time = time;
    this.boneOpacity.fill(1);
    this.skeleton.bones.forEach((bone, i) => { bone.position.copy(this.rest[i].position); bone.quaternion.copy(this.rest[i].quaternion); bone.scale.copy(this.rest[i].scale); });
    for (const playback of this.mesh.playbacks || (this.mesh.playback ? [this.mesh.playback] : [])) {
      const animation = this.mesh.animations?.find(a => a.id === playback.id);
      if (!animation || !playback.blend) continue;
      const rawFrame = time * playback.rate * animation.fps;
      const frame = animation.mode === "loop" ? (rawFrame % animation.frames + animation.frames) % animation.frames : Math.max(0, Math.min(animation.frames, rawFrame));
      const lo = Math.floor(frame), hi = Math.min(animation.frames, lo + 1), fraction = frame - lo;
      const blend = playback.blend;
      animation.opacity?.forEach((values,bone)=>{
        const sample=values[lo]*(1-fraction)+values[hi]*fraction;
        this.boneOpacity[bone]=Math.max(0,Math.min(1,playback.additive?this.boneOpacity[bone]+(sample-1)*blend:this.boneOpacity[bone]*(1-blend)+sample*blend));
      });
      for (const track of animation.tracks) {
        const bone = this.skeleton.bones[track.bone], rest = this.rest[track.bone], v = track.values;
        const at = lo * 9, next = hi * 9;
        const interpolate = (component: number) => v[at + component] * (1 - fraction) + v[next + component] * fraction;
        this.samplePosition.set(interpolate(0), interpolate(1), interpolate(2));
        this.sampleScale.set(interpolate(6), interpolate(7), interpolate(8));
        this.a.setFromEuler(this.euler.set(v[at + 3], v[at + 4], v[at + 5], "XYZ"));
        this.b.setFromEuler(this.euler.set(v[next + 3], v[next + 4], v[next + 5], "XYZ"));
        this.a.slerp(this.b, fraction);
        if (playback.additive) {
          bone.position.addScaledVector(this.samplePosition.sub(rest.position), blend);
          this.delta.copy(rest.quaternion).invert().multiply(this.a);
          this.b.identity().slerp(this.delta, blend); bone.quaternion.multiply(this.b);
          this.sampleScale.divide(rest.scale).subScalar(1).multiplyScalar(blend).addScalar(1);
          bone.scale.multiply(this.sampleScale);
        } else {
          bone.position.lerp(this.samplePosition, blend);
          bone.quaternion.slerp(this.a, blend);
          bone.scale.lerp(this.sampleScale, blend);
        }
      }
    }
    this.upload();
    return true;
  }
  private upload() {
    for (const bone of this.skeleton.bones) if (!bone.parent) bone.updateMatrixWorld(true);
    this.skeleton.update();
    const matrices = this.skeleton.boneMatrices, joints = this.mesh.joints!, weights = this.mesh.weights!, source = this.mesh.positions;
    if (!matrices) throw new Error("Scene skeleton has been disposed");
    for (let i = 0; i < source.length / 3; i++) {
      const x = source[i * 3], y = source[i * 3 + 1], z = source[i * 3 + 2];
      let a = 0, b = 0, c = 0, alpha=0;
      for (let j = 0; j < 4; j++) {
        const weight = weights[i * 4 + j]; if (!weight) continue;
        const m = joints[i * 4 + j] * 16;
        alpha+=weight*this.boneOpacity[joints[i*4+j]];
        a += weight * (matrices[m] * x + matrices[m + 4] * y + matrices[m + 8] * z + matrices[m + 12]);
        b += weight * (matrices[m + 1] * x + matrices[m + 5] * y + matrices[m + 9] * z + matrices[m + 13]);
        c += weight * (matrices[m + 2] * x + matrices[m + 6] * y + matrices[m + 10] * z + matrices[m + 14]);
      }
      this.positions[i * 3] = a; this.positions[i * 3 + 1] = b; this.positions[i * 3 + 2] = c;
      this.opacities[i]=Math.max(0,Math.min(1,alpha));
    }
  }
  dispose() { this.skeleton.dispose(); }
}
