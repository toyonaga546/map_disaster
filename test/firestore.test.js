import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {spawnSync} from 'node:child_process';
import {firestoreStore} from '../src/post-store.js';
import {createApp} from '../src/server.js';

test('接続確認は認証情報未設定を安全に報告して終了する',()=>{
  const env={...process.env,FIREBASE_PROJECT_ID:'demo-disaster-map',GOOGLE_APPLICATION_CREDENTIALS:path.join(os.tmpdir(),'missing-disaster-credentials.json')};
  delete env.FIRESTORE_EMULATOR_HOST;
  const result=spawnSync(process.execPath,['scripts/check-firebase.js'],{env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,1);assert.match(result.stderr,/Firestore接続失敗/);assert.doesNotMatch(result.stderr,/private_key|UnhandledPromiseRejection|googleauth\.js/);
});

// This mock checks our adapter contract, not Google's SDK or security rules.
function memoryFirestore() {
  const data=new Map(); let queue=Promise.resolve();
  const snapshot=ref=>({id:ref.id,exists:data.has(ref.path),data:()=>structuredClone(data.get(ref.path))});
  function batch() {
    const operations=[];
    const writer={
      create(ref,value){operations.push(['create',ref,value]);return writer;},
      update(ref,value){operations.push(['update',ref,value]);return writer;},
      delete(ref){operations.push(['delete',ref]);return writer;},
      async commit(){
        const next=new Map(data);
        for(const [operation,ref,value] of operations){
          if(operation==='create'&&next.has(ref.path))throw new Error('already exists');
          if(operation==='update'&&!next.has(ref.path))throw new Error('not found');
          if(operation==='delete')next.delete(ref.path);
          else next.set(ref.path,structuredClone(operation==='update'?{...next.get(ref.path),...value}:value));
        }
        data.clear();for(const [key,value]of next)data.set(key,value);
      }
    };
    return writer;
  }
  function collection(name,filter=()=>true,limit=Infinity){
    return {
      doc:id=>({id,path:`${name}/${id}`}),
      where(field,operator,value){assert.equal(operator,'==');return collection(name,item=>filter(item)&&item[field]===value,limit);},
      limit(n){return collection(name,filter,n);},
      async get(){return {docs:[...data.keys()].filter(key=>key.startsWith(name+'/')&&filter(data.get(key))).slice(0,limit).map(key=>snapshot({id:key.split('/')[1],path:key}))};}
    };
  }
  return {
    data,collection,batch,
    async getAll(...refs){return refs.map(snapshot);},
    runTransaction(fn){
      const result=queue.then(async()=>{const writer=batch();const value=await fn({...writer,get:async ref=>snapshot(ref)});await writer.commit();return value;});
      queue=result.catch(()=>{});return result;
    }
  };
}

test('Firestoreアダプター: 公開/非公開の分離・同意・原子的作成・競合する部分更新・削除（モック）',async()=>{
  const db=memoryFirestore(),store=firestoreStore(db);
  const first={id:'one',description:'before',ai:{status:'pending'}};
  await store.create(first,{token_hash:'secret-hash',gps_samples:[{latitude:35}],ai_consent:true});
  await store.create({id:'two',description:'no consent'},{token_hash:'another',gps_samples:[],ai_consent:false});
  assert.ok(db.data.has('posts/one'));assert.ok(db.data.has('postPrivate/one'));
  assert.ok(!(await store.list()).some(post=>'token_hash' in post || 'gps_samples' in post));
  assert.deepEqual((await store.listConsenting()).map(p=>p.id),['one']);
  const original=await store.get('one');assert.equal(original.private.token_hash,'secret-hash');
  await assert.rejects(()=>store.create({...first,description:'duplicate'},{token_hash:'overwritten'}));
  assert.deepEqual(await store.get('one'),original);
  await Promise.all([store.patch('one',{description:'edited'}),store.patch('one',{ai:{status:'complete'}})]);
  assert.equal((await store.get('one')).post.description,'edited');assert.equal((await store.get('one')).post.ai.status,'complete');
  await store.delete('one');assert.equal(await store.get('one'),null);assert.ok(!db.data.has('postPrivate/one'));
  assert.equal(await store.patch('one',{description:'resurrect'}),null);await store.check();
});

test('Firestore利用時も投稿APIはGPS履歴・トークンを公開せず管理リンクを検証する（モック）',async()=>{
  const db=memoryFirestore(),store=firestoreStore(db);
  const directory=await mkdtemp(path.join(os.tmpdir(),'disaster-firestore-'));
  const {server}=await createApp(directory,store);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#234432'}}).jpeg().toBuffer();
    const response=await fetch(base+'/api/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({latitude:35,longitude:139,description:'Firestoreモックの投稿',samples:[{latitude:35,longitude:139,accuracy:10,recorded_at:Date.now()}],image:'data:image/jpeg;base64,'+bytes.toString('base64'),ai_consent:false})});
    assert.equal(response.status,201);const {post,management_token}=await response.json();
    const stored=await store.get(post.id);assert.equal(stored.private.gps_samples.length,1);assert.equal(stored.private.ai_consent,false);
    const listed=await (await fetch(base+'/api/posts')).json();
    assert.equal(listed.length,1);assert.ok(!JSON.stringify(listed).includes(management_token));assert.ok(!JSON.stringify(listed).includes('gps_samples'));
    const denied=await fetch(base+`/api/posts/${post.id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer invalid'},body:JSON.stringify({description:'unauthorized'})});assert.equal(denied.status,403);
    const edited=await fetch(base+`/api/posts/${post.id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${management_token}`},body:JSON.stringify({description:'編集後'})});assert.equal(edited.status,200);assert.equal((await edited.json()).description,'編集後');
    const deleted=await fetch(base+`/api/posts/${post.id}`,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${management_token}`}});assert.equal(deleted.status,200);assert.equal(await store.get(post.id),null);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
