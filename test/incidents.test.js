import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIncidents, incidentTimeline } from '../public/incidents.js';

const start = Date.parse('2026-11-24T00:00:00Z');
function post(id, hours = 0, longitude = 139, category = 'flood') {
  return {id,created_at:new Date(start + hours * 3600000).toISOString(),
    latitude:35,longitude,hazard:{status:'complete',category},description:id,image_url:'/images/'+id+'.jpg'};
}
test('近い同種の投稿をまとめ、別種・遠方・期限後の再発を分離する', () => {
  const groups = groupIncidents([
    post('a'), post('b',1,139.001), post('road',1,139,'road'),
    post('far',1,140),post('recurrence',50)
  ],start+51*3600000);
  assert.deepEqual(groups.map(group=>group.posts.map(post=>post.id)),[['a','b'],['far'],['road'],['recurrence']]);
  assert.equal(groups[0].active.length,0);
  assert.equal(groups.at(-1).active.length,1);
});
test('解消後の再発と未分類投稿を分離し、地点の連鎖で広がり過ぎない', () => {
  const resolved = {...post('a'),resolved_at:new Date(start+3600000).toISOString()};
  assert.equal(groupIncidents([resolved,post('b',2)]).length,2);
  assert.equal(groupIncidents([post('a',0,139,'unknown'),post('b',0,139,'unknown')]).length,2);
  assert.equal(groupIncidents([post('a'),post('b',1,139.002),post('c',2,139.004)]).length,2);
});
test('現在の範囲には有効な投稿だけを含め、時系列には期限切れを含めて通常投稿だけを並べる', () => {
  const first=post('a');
  const second={...post('b',23),condition_report:{
    status:'resolved',observed_at:new Date(start+25*3600000).toISOString(),note:'水が引いた',image_url:'photo'
  },resolved_at:new Date(start+26*3600000).toISOString()};
  const third=post('c',25);
  const [group]=groupIncidents([third,second,first],start+27*3600000);
  assert.deepEqual(group.active.map(post=>post.id),['c']);
  assert.deepEqual(incidentTimeline(group).map(event=>event.label),
    ['投稿','投稿','投稿']);
});
