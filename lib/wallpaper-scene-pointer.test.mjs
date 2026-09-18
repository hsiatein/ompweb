import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {sceneCursorPosition,pointInSceneMesh}=await createJiti(import.meta.url).import('./wallpaper-scene-pointer.ts');
test('pointer mapping respects cover crops, contain letterboxing, offset and fill',()=>{
  const scene={width:200,height:100},rect={left:20,top:30,width:100,height:100};
  assert.deepEqual(sceneCursorPosition(scene,rect,{x:70,y:80},'cover'),[100,50,0]);
  assert.deepEqual(sceneCursorPosition(scene,rect,{x:70,y:80},'cover','0% 50%'),[50,50,0]);
  assert.deepEqual(sceneCursorPosition(scene,rect,{x:70,y:80},'cover','100% 50%'),[150,50,0]);
  assert.deepEqual(sceneCursorPosition(scene,rect,{x:120,y:105},'contain'),[200,0,0]);
  assert.deepEqual(sceneCursorPosition(scene,rect,{x:45,y:55},'fill'),[50,75,0]);
});
test('mesh hit tests use deformed triangles, not bounding rectangles or winding',()=>{
  const p=[0,0,0,10,0,0,0,10,0];
  assert.equal(pointInSceneMesh(2,3,p,[0,1,2]),true);assert.equal(pointInSceneMesh(2,3,p,[2,1,0]),true);
  assert.equal(pointInSceneMesh(8,8,p,[0,1,2]),false);assert.equal(pointInSceneMesh(0,0,p,[0,0,0]),false);
});
