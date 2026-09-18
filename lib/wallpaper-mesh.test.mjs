import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {decodeSceneMesh}=await createJiti(import.meta.url).import('./wallpaper-mesh.ts');
const {SceneMeshAnimator}=await createJiti(import.meta.url).import('./wallpaper-skinning.ts');
const uint=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b};
const float=n=>{const b=Buffer.alloc(4);b.writeFloatLE(n);return b};
const fixture=()=>Buffer.concat([Buffer.from('MDLV0013\0'),uint(9),uint(1),uint(1),Buffer.from('materials/a.json\0'),uint(0),uint(60),...[0,0,0,0,0, 10,0,0,1,0, 0,10,0,0,1].map(float),uint(6),Buffer.from([0,0,1,0,2,0])]);
test('MDL mesh preserves actual triangles and UVs, including padded files',()=>{
  const result=decodeSceneMesh(Buffer.concat([fixture(),Buffer.alloc(32)]));
  assert.deepEqual(result.positions,[0,0,0,10,0,0,0,10,0]);
  assert.deepEqual(result.uvs,[0,0,1,0,0,1]);assert.deepEqual(result.indices,[0,1,2]);
});
test('MDL mesh rejects truncation, bad indices, mismatched layouts and animation tails',()=>{
  const b=fixture();for(let i=0;i<b.length;i++)assert.throws(()=>decodeSceneMesh(b.subarray(0,i)));
  const index=Buffer.from(b);index.writeUInt16LE(3,index.length-2);assert.throws(()=>decodeSceneMesh(index),/index/);
  const skin=Buffer.from(b);skin.writeUInt32LE(0x1800009,9);assert.throws(()=>decodeSceneMesh(skin),/vertex count/);
  assert.throws(()=>decodeSceneMesh(Buffer.concat([b,Buffer.from('MDLS0001')])) ,/skeletal/);
});

function animatedFixture({parent=-1,joint=0,weight=1}={}){
  const geometry=Buffer.concat([Buffer.from('MDLV0013\0'),uint(0x1800009),uint(1),uint(1),Buffer.from('materials/a.json\0'),uint(0),uint(156),
    ...[[0,0,0,0,0],[10,0,0,1,0],[0,10,0,0,1]].flatMap(v=>[...v.slice(0,3).map(float),uint(joint),uint(0),uint(0),uint(0),...[weight,0,0,0,...v.slice(3)].map(float)]),uint(6),Buffer.from([0,0,1,0,2,0])]);
  const bone=Buffer.concat([Buffer.from([0]),uint(1),uint(parent>>>0),uint(64),...[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1].map(float),Buffer.from('root\0')]);
  const skeleton=Buffer.concat([Buffer.from('MDLS0001\0'),uint(geometry.length+17+bone.length),uint(1),bone]);
  const clip=Buffer.concat([uint(7),uint(0),Buffer.from('wave\0loop\0'),float(1),uint(2),uint(0),uint(1),uint(0),uint(108),
    ...[0,10,0].flatMap(x=>[x,0,0,0,0,0,1,1,1].map(float)),uint(0)]);
  return Buffer.concat([geometry,skeleton,Buffer.from('MDLA0001\0'),uint(geometry.length+skeleton.length+17+clip.length),uint(1),clip]);
}

test('MDL skeleton, weights and sampled animation decode and move real vertices',t=>{
  const mesh=decodeSceneMesh(animatedFixture());mesh.playback={id:7,rate:1,blend:1};
  assert.equal(mesh.bones.length,1);assert.equal(mesh.animations[0].tracks[0].values.length,27);
  const animation=new SceneMeshAnimator(mesh);t.after(()=>animation.dispose());
  animation.update(0);assert.deepEqual([...animation.positions],mesh.positions);
  animation.update(.5);assert.equal(animation.positions[0],5);assert.equal(animation.positions[3],15);
  animation.update(2);assert.equal(animation.positions[0],0,'loop returns to its initial pose');
  assert.equal(animation.update(2),false,'paused animation does not re-upload');
  mesh.playback.blend=.5;animation.update(1);assert.equal(animation.positions[0],5);
  mesh.playback.rate=-1;mesh.playback.blend=1;animation.update(.5);assert.equal(animation.positions[0],5);
  assert.equal(mesh.positions[0],0,'bind vertices remain unchanged');
});

test('MDL skeleton parser rejects bad hierarchy, weights, boundaries and truncated tracks',()=>{
  assert.throws(()=>decodeSceneMesh(animatedFixture({parent:0})),/bone transform/);
  assert.throws(()=>decodeSceneMesh(animatedFixture({joint:1})),/skin joint/);
  assert.throws(()=>decodeSceneMesh(animatedFixture({weight:.5})),/skin weights/);
  const data=animatedFixture();for(let i=0;i<data.length;i++)assert.throws(()=>decodeSceneMesh(data.subarray(0,i)));
  const boundary=Buffer.from(data);boundary.writeUInt32LE(1,boundary.indexOf('MDLS0001')+9);assert.throws(()=>decodeSceneMesh(boundary),/boundary/);
});

test('skin transform uses inverse bind pose and parent hierarchy',t=>{
  const matrix=x=>[1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1];
  const mesh={positions:[8,0,0],uvs:[0,0],indices:[],joints:[1,0,0,0],weights:[1,0,0,0],bones:[{parent:-1,matrix:matrix(5)},{parent:0,matrix:matrix(3)}],
    animations:[{id:1,frames:1,fps:1,mode:'once',tracks:[{bone:0,values:[5,0,0,0,0,0,1,1,1,15,0,0,0,0,0,1,1,1]},{bone:1,values:[3,0,0,0,0,0,1,1,1,3,0,0,0,0,0,1,1,1]}]}],playback:{id:1,rate:1,blend:1}};
  const a=new SceneMeshAnimator(mesh);t.after(()=>a.dispose());a.update(0);assert.equal(a.positions[0],8);
  a.update(1);assert.equal(a.positions[0],18);a.update(10);assert.equal(a.positions[0],18,'once clips clamp');
});

function modernFixture({animated=true,newest=false,clipping=false}={}){
  const matrix=x=>[1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1].map(float);
  let geometry=Buffer.concat([Buffer.from(newest?'MDLV0023\0':'MDLV0019\0'),uint(0x1800009),uint(1),uint(1),Buffer.from('materials/a.json\0'),uint(newest?4:0),Buffer.alloc(24),uint(0x180000f),uint(240),
    ...[[0,0,0,0,0],[10,0,0,1,0],[0,10,0,0,1]].flatMap(v=>[...v.slice(0,3).map(float),...[0,0,1,1,0,0,1].map(float),...[0,0,0,0].map(uint),...[1,0,0,0,...v.slice(3)].map(float)]),uint(6),Buffer.from([0,0,1,0,2,0])]);
  const bone=Buffer.concat([Buffer.from('root\0'),uint(0),uint(0xffffffff),uint(64),...matrix(0),Buffer.from('{}\0')]);
  if(newest)geometry=Buffer.concat([geometry,...(clipping?[Buffer.from([1]),uint(1),uint(36),...[0,0,0,10,0,0,0,10,0].map(float)]:[Buffer.from([0])]),Buffer.from([1]),uint(16),uint(0),uint(0),uint(0),uint(3),uint(clipping?1:0),...(clipping?[uint(123),uint(0),Buffer.from('masks/test\0'),uint(0),uint(1),uint(0),uint(1),uint(0)]:[])]);
  const metadata=Buffer.concat([Buffer.alloc(2),Buffer.from([1]),...matrix(10),Buffer.alloc(8),Buffer.from([1]),...Array(19).fill(0).map(float),Buffer.from([1]),uint(0),...(newest?[Buffer.from([1]),uint(0)]:[])]);
  const skeleton=Buffer.concat([Buffer.from(newest?'MDLS0004\0':'MDLS0002\0'),uint(geometry.length+17+bone.length+metadata.length),uint(1),bone,metadata]);
  if(!animated)return Buffer.concat([geometry,skeleton]);
  const attach=Buffer.concat([Buffer.from([1,0,0,0]),Buffer.from('hand\0'),...matrix(3)]);
  const attachment=Buffer.concat([Buffer.from('MDAT0001\0'),uint(geometry.length+skeleton.length+13+attach.length),attach]);
  const clips=[20,40].map((x,i)=>Buffer.concat([uint(i+1),uint(0),Buffer.from('wave\0loop\0'),float(1),uint(2),uint(0),uint(1),uint(0),uint(108),
    ...[10,x,10].flatMap(t=>[t,0,0,0,0,0,1,1,1].map(float)),uint(0),...(newest?[Buffer.from([1]),uint(0),uint(12),...[1,0,1].map(float)]:[]),Buffer.alloc(30)]));
  const data=Buffer.concat([geometry,skeleton,attachment,Buffer.from(newest?'MDLA0006\0':'MDLA0005\0'),uint(geometry.length+skeleton.length+attachment.length+17+clips.reduce((n,c)=>n+c.length,0)),uint(2),...clips]);
  return clipping?Buffer.concat([data,Buffer.from('MDLE0002\0'),uint(data.length+17+64),uint(64),...matrix(5),Buffer.from([0])]):data;
}

test('MDLV23 clipping keeps bounded bone paths and edited pose coordinates',t=>{
  const data=modernFixture({newest:true,clipping:true}),mesh=decodeSceneMesh(data);
  assert.deepEqual(mesh.clips,[{texture:'masks/test',bonePath:[0],target:0,vertices:[0,1,2]}]);
  assert.equal(mesh.editedPose[0][12],5);assert.deepEqual(mesh.editedPositions,mesh.positions);
  mesh.playback={id:1,rate:1,blend:1};const a=new SceneMeshAnimator(mesh);t.after(()=>a.dispose());
  a.update(0);assert.equal(a.clippingMatrix(0).elements[12],-5);
  a.update(1);assert.equal(a.clippingMatrix(0).elements[12],-15);
  const bad=Buffer.from(data);bad.writeUInt32LE(999,bad.indexOf('masks/test')+11+16);assert.throws(()=>decodeSceneMesh(bad),/hierarchy/);
  for(const end of [data.indexOf('MDLE0002'),data.length-2])assert.throws(()=>decodeSceneMesh(data.subarray(0,end)));
});

test('MDLV23 preserves draw groups and per-bone opacity clips through skinning',t=>{
  const mesh=decodeSceneMesh(modernFixture({newest:true}));assert.deepEqual(mesh.indices,[0,1,2]);assert.deepEqual(mesh.animations[0].opacity,[[1,0,1]]);
  mesh.playbacks=[{id:1,rate:1,blend:1}];const a=new SceneMeshAnimator(mesh);t.after(()=>a.dispose());
  a.update(0);assert.deepEqual([...a.opacities],[1,1,1]);a.update(.5);assert.deepEqual([...a.opacities],[.5,.5,.5]);
  a.update(1);assert.deepEqual([...a.opacities],[0,0,0]);a.update(2);assert.deepEqual([...a.opacities],[1,1,1]);
  mesh.playbacks[0].blend=.5;a.update(1);assert.deepEqual([...a.opacities],[.5,.5,.5]);
});

test('MDLV23 rejects bad group ranges, clipping, opacity payloads and section truncation',()=>{
  const data=modernFixture({newest:true}),geoEnd=data.indexOf('MDLS0004')-26;
  for(const offset of [geoEnd,geoEnd+2,geoEnd+14,geoEnd+22]){const bad=Buffer.from(data);bad[offset]=255;assert.throws(()=>decodeSceneMesh(bad));}
  const bad=Buffer.from(data);bad.writeFloatLE(2,bad.length-34);assert.throws(()=>decodeSceneMesh(bad),/opacity value/);
  for(const end of [geoEnd+1,geoEnd+12,data.length-1,data.length-45])assert.throws(()=>decodeSceneMesh(data.subarray(0,end)));
});

test('MDLV19 decodes extended vertices, named bones, reference poses and attachments',t=>{
  const mesh=decodeSceneMesh(modernFixture());
  assert.deepEqual(mesh.positions,[0,0,0,10,0,0,0,10,0]);assert.equal(mesh.bones[0].name,'root');
  assert.equal(mesh.referencePose[0][12],10);assert.equal(mesh.attachments[0].name,'hand');assert.equal(mesh.attachments[0].matrix[12],3);
  assert.deepEqual(mesh.animations.map(a=>a.id),[1,2]);
  mesh.playbacks=[{id:1,blend:1,rate:1,additive:true},{id:2,blend:1,rate:1,additive:true}];
  const a=new SceneMeshAnimator(mesh);t.after(()=>a.dispose());
  a.update(0);assert.equal(a.positions[0],10,'reference pose assembles the bind sheet exactly once');
  assert.equal(a.attachment('hand')[12],13);
  a.update(1);assert.equal(a.positions[0],50,'additive clips contribute deltas, not duplicate reference offsets');
  assert.equal(a.attachment('hand')[12],53);
  a.update(2);assert.equal(a.positions[0],10,'looping does not accumulate drift');
  mesh.playbacks[1].blend=.5;a.update(1);assert.equal(a.positions[0],35);
  mesh.playbacks[1].additive=false;a.update(.999);assert.ok(Math.abs(a.positions[0]-30)<.04);
});

test('MDLV19 static skeletons assemble without animation; malformed section and track data fail closed',t=>{
  const mesh=decodeSceneMesh(modernFixture({animated:false})),a=new SceneMeshAnimator(mesh);t.after(()=>a.dispose());a.update(0);assert.equal(a.positions[0],10);
  const data=modernFixture();
  for(const end of [8,31,170,data.length-1,data.length-30,data.length-100])assert.throws(()=>decodeSceneMesh(data.subarray(0,end)));
  for(const tag of ['MDLS0002','MDAT0001','MDLA0005']){const bad=Buffer.from(data);bad.writeUInt32LE(1,bad.indexOf(tag)+9);assert.throws(()=>decodeSceneMesh(bad),/boundary/);}
  const bad=Buffer.from(data);bad[bad.length-1]=1;assert.throws(()=>decodeSceneMesh(bad),/metadata/);
});
