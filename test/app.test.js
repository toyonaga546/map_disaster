import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { gpsResult, distance, priority } from '../src/domain.js';
import { compareImages } from '../src/ai.js';

test('距離計算とGPSの精度・未取得・矛盾の評価',()=>{
  assert.equal(distance({latitude:0,longitude:0},{latitude:0,longitude:0}),0);
  assert.ok(Math.abs(distance({latitude:0,longitude:0},{latitude:0,longitude:1})-111195)<5);
  const point={latitude:35,longitude:139};
  assert.equal(gpsResult(point,[]).status,'unknown');
  assert.equal(gpsResult(point,[{...point,accuracy:1500}]).status,'unknown');
  assert.equal(gpsResult(point,[{...point,accuracy:10}]).status,'consistent');
  assert.equal(gpsResult(point,[{latitude:36,longitude:139,accuracy:10}]).status,'attention');
});
test('最新3件と整合性上位3件を重複なく選ぶ',()=>{
  const posts=Array.from({length:8},(_,i)=>({id:String(i),created_at:`2026-10-${String(20-i).padStart(2,'0')}`,gps:{status:i>4?'consistent':'unknown'},ai:{result:'unknown'}}));
  const result=priority(posts);
  assert.deepEqual(result.map(p=>p.id),['0','1','2','5','6','7']);
  assert.equal(new Set(priority(posts.slice(4)).map(p=>p.id)).size,4);
});
let app,dir,base;
before(async()=>{dir=await mkdtemp(path.join(os.tmpdir(),'disaster-test-'));app=await createApp(dir);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;});
after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();await rm(dir,{recursive:true,force:true});});
async function request(route,method='GET',value,token){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(value?{body:JSON.stringify(value)}:{})});return {status:response.status,body:await response.json()};}
async function fixture(){const image=await sharp({create:{width:20,height:20,channels:3,background:'#345a43'}}).jpeg().withExif({IFD0:{Make:'TestCamera',Software:'Photo Editor'}}).toBuffer();return {latitude:35.68,longitude:139.76,description:'現地で確認した状況です。',samples:[{latitude:35.68,longitude:139.76,accuracy:10,recorded_at:Date.now()}],image:`data:image/jpeg;base64,${image.toString('base64')}`,ai_consent:false};}
test('投稿→永続保存→非公開情報の除外→専用リンク編集削除',async()=>{
  const created=await request('/api/posts','POST',await fixture());assert.equal(created.status,201);
  const {post,management_token:token}=created.body;
  assert.equal(token.length,43);assert.equal(post.gps.status,'consistent');
  assert.equal(post.metadata.software,'Photo Editor');assert.equal(post.metadata.warnings.length,1);
  const row=app.db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
  assert.notEqual(row.token_hash,token);assert.equal(JSON.parse(row.gps_private).length,1);
  const list=await request('/api/posts');assert.equal(list.body.length,1);
  assert.ok(!JSON.stringify(list.body).includes(token));assert.ok(!JSON.stringify(list.body).includes('recorded_at'));assert.ok(!JSON.stringify(list.body).includes('gps_private'));
  const uploaded=Buffer.from(await (await fetch(base+post.image_url)).arrayBuffer());
  const meta=await sharp(uploaded).metadata();assert.equal(meta.exif,undefined);
  assert.equal((await request(`/api/posts/${post.id}`,'PATCH',{description:'編集'},'invalid')).status,403);
  assert.equal((await request(`/api/posts/${post.id}`,'DELETE',null,'invalid')).status,403);
  assert.equal((await request(`/api/posts/${post.id}`,'PATCH',{description:'変更後'},token)).status,200);
  assert.equal((await request(`/api/posts/${post.id}`)).body.post.description,'変更後');
  assert.equal((await request(`/api/posts/${post.id}`,'DELETE',null,token)).status,200);
  assert.equal((await request(`/api/posts/${post.id}`)).status,404);
  assert.equal((await fetch(base+post.image_url)).status,404);
});
test('不正な座標・画像・GPSと異なるオリジンを拒否',async()=>{
  const input=await fixture();
  for(const change of [{latitude:91},{description:''},{image:'data:image/svg+xml;base64,PHN2Zz4='},{samples:[{latitude:0,longitude:0,accuracy:-1,recorded_at:Date.now()}]}])assert.equal((await request('/api/posts','POST',{...input,...change})).status,400);
  const response=await fetch(base+'/api/posts',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.example'},body:JSON.stringify(input)});assert.equal(response.status,403);
});
test('同一地点履歴とAI未設定状態を表示しDB再オープン後も保存される',async()=>{
  const a=(await request('/api/posts','POST',await fixture())).body.post;
  const b=(await request('/api/posts','POST',await fixture())).body.post;
  await new Promise(resolve=>setImmediate(resolve));
  const detail=(await request(`/api/posts/${a.id}`)).body;
  assert.equal(detail.history.length,2);assert.equal(detail.post.ai.status,'unavailable');
  const second=await createApp(dir);assert.equal(second.db.prepare('SELECT count(*) AS n FROM posts').get().n,2);second.db.close();
  const original=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;
  try{assert.equal((await compareImages('unused','unused')).status,'unavailable');}finally{if(original)process.env.OPENAI_API_KEY=original;}
  assert.ok(b.id);
});
test('AI画像比較の成功・不正応答・タイムアウト相当の失敗（モック）',async()=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
  const file=path.join(dir,'images',(await request('/api/posts')).body[0].id+'.jpg');
  try {
    let sent;
    const result=await compareImages(file,file,async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({result:'consistent',reason:'道路の特徴が共通しています。'})}}]})};});
    assert.equal(result.result,'consistent');assert.equal(sent.messages[1].content.length,2);assert.equal(sent.store,false);
    assert.equal((await compareImages(file,file,async()=>{throw new Error('timeout');})).status,'unavailable');
    assert.equal((await compareImages(file,file,async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"result":"truth","reason":"bad"}'}}]})}))).status,'unavailable');
    assert.equal((await compareImages(file,null)).status,'unavailable');
  }finally{if(old)process.env.OPENAI_API_KEY=old;else delete process.env.OPENAI_API_KEY;}
});
