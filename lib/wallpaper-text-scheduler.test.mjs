import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {SceneTextScheduler}=await createJiti(import.meta.url).import('./wallpaper-text-scheduler.ts');

test('text layers share a bounded frame budget and resume fairly after expensive drawing', t => {
  let clock=0;
  t.mock.method(performance,'now',()=>clock);
  const calls=[], scheduler=new SceneTextScheduler();
  const layers=[0,1,2].map(id=>({update(time,now,budget){calls.push({id,time,now,budget});clock+=9;}}));
  for(let frame=0;frame<6;frame++) scheduler.update(layers,frame,100+frame);
  assert.deepEqual(calls.map(c=>c.id),[0,1,2,0,1,2]);
  assert.ok(calls.every((c,i)=>c.budget===8&&c.time===i&&c.now===100+i));
});

test('a tight or expired budget does not enter guest code or lose its pending turn', t => {
  let clock=0;
  t.mock.method(performance,'now',()=>clock);
  const calls=[], scheduler=new SceneTextScheduler();
  const layers=[0,1].map(id=>({update(){calls.push(id);clock+=7.5;}}));
  scheduler.update(layers,0,0);
  assert.deepEqual(calls,[0]);
  for(const budget of [0,.5,-1,NaN,Infinity]) scheduler.update(layers,1,1,budget);
  scheduler.update([],1,1);
  assert.deepEqual(calls,[0]);
  scheduler.update(layers,2,2);
  assert.deepEqual(calls,[0,1]);
});

test('inexpensive text layers can all update in one frame', t => {
  t.mock.method(performance,'now',()=>0);
  const calls=[],scheduler=new SceneTextScheduler(),layers=[0,1,2].map(id=>({update(){calls.push(id);}}));
  scheduler.update(layers,0,0);scheduler.update(layers,1,1);
  assert.deepEqual(calls,[0,1,2,0,1,2]);
});
