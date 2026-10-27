import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {firebaseImageStore,localImageStore} from '../src/image-store.js';
import {createSqliteStore} from '../src/post-store.js';
import {createApp} from '../src/server.js';
import {compareImages} from '../src/ai.js';

function memoryBucket(){
  const objects=new Map();
  const bucket={objects,failSave:false,failDelete:false,
    async getMetadata(){return [{name:'demo-disaster.firebasestorage.app'}];},
    file(name){return {
      async save(bytes,options){
        if(bucket.failSave)throw Object.assign(new Error('upload denied'),{code:403});
        assert.equal(options.preconditionOpts.ifGenerationMatch,0);
        assert.equal(options.metadata.contentType,'image/jpeg');
        assert.equal(options.validation,'crc32c');
        assert.ok(!options.metadata.metadata?.firebaseStorageDownloadTokens);
        if(objects.has(name))throw Object.assign(new Error('duplicate'),{code:412});
        objects.set(name,Buffer.from(bytes));
      },
      async download(){if(!objects.has(name))throw Object.assign(new Error('missing'),{code:404});return [objects.get(name)];},
      async delete(options){
        assert.equal(options.ignoreNotFound,true);
        if(bucket.failDelete)throw Object.assign(new Error('delete denied'),{code:403});
        objects.delete(name);
      }
    };}
  };
  return bucket;
}
async function withCloudApp(fn){
  const directory=await mkdtemp(path.join(os.tmpdir(),'disaster-storage-'));
  const bucket=memoryBucket(),store=await createSqliteStore(directory),images=firebaseImageStore(bucket);
  const app=await createApp(directory,store,images);
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(route,method='GET',body,token)=>{
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  try{await fn({directory,bucket,store,images,request,base});}
  finally{await new Promise(resolve=>app.server.close(resolve));await store.close();await images.close();await rm(directory,{recursive:true,force:true});}
}
async function fixture(){
  const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#245748'}}).jpeg().withExif({IFD0:{Make:'Test',Software:'Test editor'}}).toBuffer();
  return {description:'Storageの動作確認',latitude:35,longitude:139,samples:[],ai_consent:false,image:'data:image/jpeg;base64,'+bytes.toString('base64')};
}

test('FirestoreとCloud Storageの構成ではローカル保存ディレクトリを作らない',async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'disaster-no-disk-'));
  let closed=false;
  try{
    const directory=path.join(parent,'absent');
    const store={async list(){return [];},async close(){closed=true;}};
    const app=await createApp(directory,store,firebaseImageStore(memoryBucket()));
    await assert.rejects(()=>access(directory));await app.store.close();await app.images.close();assert.ok(closed);
  }finally{await rm(parent,{recursive:true,force:true});}
});

test('Cloud Storageの写真をAPIで表示し、EXIF除去とローカル未保存を確認。権限検証後に削除（モック）',async()=>withCloudApp(async({directory,bucket,store,request,base})=>{
  const created=await request('/api/posts','POST',await fixture());assert.equal(created.status,201);
  const {post,management_token}=created.body;
  assert.equal(post.image_storage,'firebase');assert.equal(bucket.objects.size,1);
  await assert.rejects(()=>access(path.join(directory,'images')));
  const response=await fetch(base+post.image_url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal((await sharp(bytes).metadata()).exif,undefined);
  const head=await fetch(base+post.image_url,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await request('/api/posts/'+post.id,'DELETE',null,'invalid')).status,403);assert.equal(bucket.objects.size,1);
  assert.equal((await request('/api/posts/'+post.id,'DELETE',null,management_token)).status,200);
  assert.equal(bucket.objects.size,0);assert.equal(await store.get(post.id),null);assert.equal((await fetch(base+post.image_url)).status,404);
}));

test('Storageへのアップロード失敗時は投稿を作成せず、DB保存失敗時は写真を片付ける（モック）',async()=>withCloudApp(async({bucket,store,request})=>{
  bucket.failSave=true;assert.equal((await request('/api/posts','POST',await fixture())).status,500);
  assert.equal((await store.list()).length,0);assert.equal(bucket.objects.size,0);
  bucket.failSave=false;store.create=async()=>{throw new Error('DB unavailable');};
  assert.equal((await request('/api/posts','POST',await fixture())).status,500);
  assert.equal(bucket.objects.size,0);assert.equal((await store.list()).length,0);
}));

test('Storage削除失敗を成功扱いせず、投稿と管理権限を残して再試行できる（モック）',async()=>withCloudApp(async({bucket,store,request})=>{
  const {post,management_token}= (await request('/api/posts','POST',await fixture())).body;
  bucket.failDelete=true;assert.equal((await request('/api/posts/'+post.id,'DELETE',null,management_token)).status,500);
  assert.ok(await store.get(post.id));assert.equal(bucket.objects.size,1);
  bucket.failDelete=false;assert.equal((await request('/api/posts/'+post.id,'DELETE',null,management_token)).status,200);assert.equal(await store.get(post.id),null);
}));

test('切り替え前のローカル写真を引き続き表示でき、孤立したStorage画像を公開しない（モック）',async()=>withCloudApp(async({directory,bucket,store,request,base})=>{
  const id=randomUUID(),bytes=Buffer.from('legacy image');
  const local=localImageStore(directory);await local.save(id,bytes);
  await store.create({id,latitude:35,longitude:139,created_at:new Date().toISOString(),description:'legacy',ai:{status:'complete'}},{token_hash:'a'.repeat(64),gps_samples:[],ai_consent:false});
  const response=await fetch(base+`/images/${id}.jpg`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const orphan=randomUUID();bucket.objects.set(`posts/${orphan}.jpg`,Buffer.from('orphan'));
  assert.equal((await fetch(base+`/images/${orphan}.jpg`)).status,404);
  assert.equal((await request('/api/posts')).status,200);
}));

test('クラウド写真のBufferをAI比較へ渡せる（APIモック、外部送信なし）',async()=>{
  const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
  try{
    const bytes=Buffer.from('test image');let sent;
    const result=await compareImages(bytes,bytes,async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"result":"unknown","reason":"比較材料が不足しています。"}'}}]})};});
    assert.equal(result.status,'complete');assert.equal(sent.messages[1].content[0].image_url.url,'data:image/jpeg;base64,'+bytes.toString('base64'));
  }finally{if(original)process.env.OPENAI_API_KEY=original;else delete process.env.OPENAI_API_KEY;}
});
