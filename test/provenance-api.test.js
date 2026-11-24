import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {inspectOpenAIProvenance,summarizeOpenAIProvenance} from '../src/provenance-api.js';
import {combineProvenance,inspectImageProvenance} from '../src/provenance.js';
import {provenanceHTML} from '../public/provenance.js';
import {createApp} from '../src/server.js';

const noSignal={object:'content_provenance_check',results:[
  {type:'c2pa',outcome:'not_detected',validation_state:'not_present',issuer:null},
  {type:'synthid',outcome:'not_detected'}
]};
const ok=body=>({ok:true,json:async()=>body});
const localUnknown={status:'not_present',reason:'来歴情報がありません。'};
const apiOptions=request=>({consent:true,apiKey:'test-only',request});
const remote=body=>summarizeOpenAIProvenance(body);

test('検出なし・署名のみ・無効署名は実写とせずunknown、C2PAと透かしは独立に評価',()=>{
  const negative=remote(noSignal);
  assert.equal(combineProvenance(localUnknown,negative).status,'unknown');
  assert.equal(combineProvenance({status:'verified'},negative).status,'unknown');
  assert.equal(combineProvenance({status:'invalid'},negative).status,'unknown');
  const generated={status:'ai_generated',issuer:'Trusted third party',reason:'AI生成の記録あり'};
  assert.equal(combineProvenance(generated,negative).status,'ai_generated');
  const watermarked=remote({...noSignal,results:[{type:'synthid',outcome:'detected',model:'gpt-image'}]});
  assert.equal(combineProvenance(localUnknown,watermarked).status,'ai_signal');
  assert.equal(combineProvenance({status:'invalid'},watermarked).status,'ai_signal');
  const signed=remote({object:'content_provenance_check',results:[{type:'c2pa',outcome:'detected',validation_state:'trusted',issuer:'OpenAI OpCo, LLC'}]});
  assert.equal(combineProvenance(localUnknown,signed).status,'ai_generated');
  assert.equal(combineProvenance({status:'invalid'},signed).status,'unknown');
  const edited={status:'ai_edited',reason:'AI編集あり'};
  assert.equal(combineProvenance(edited,watermarked).status,'ai_edited');
  for(const malformed of [null,{}, {object:'other',results:noSignal.results}, {object:'content_provenance_check',results:[{type:'synthid',outcome:'maybe'}]}, {object:'content_provenance_check',results:[{type:'synthid',outcome:'detected'},{type:'synthid',outcome:'not_detected'}]}]){
    assert.equal(combineProvenance(localUnknown,remote(malformed)).status,'unknown');
  }
  const badSignature=remote({object:'content_provenance_check',results:[{type:'c2pa',outcome:'detected',validation_state:'invalid',issuer:'OpenAI OpCo, LLC'}]});
  assert.equal(combineProvenance(localUnknown,badSignature).status,'unknown');
});

test('元画像のバイト列をmultipartで送信し、元ファイル名・加工後画像を送らない',async()=>{
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#456'}}).png().withExif({IFD0:{Make:'Test camera'}}).toBuffer();
  let calls=0;
  const result=await inspectImageProvenance(bytes,'image/png',apiOptions(async(url,options)=>{
    calls++;
    assert.equal(url,'https://api.openai.com/v1/content_provenance_checks');
    assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer test-only');
    assert.equal(options.headers['Content-Type'],undefined); // fetch adds the multipart boundary.
    const file=options.body.get('file');
    assert.equal(file.name,'image.png');assert.equal(file.type,'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
    return ok({...noSignal,results:[...noSignal.results.slice(0,1),{type:'synthid',outcome:'detected'}]});
  }));
  assert.equal(calls,1);assert.equal(result.status,'ai_signal');assert.equal(result.c2pa.status,'not_present');
});

test('未同意・キーなし・非対応ファイルは外部通信せず判定不可',async()=>{
  let calls=0;const request=async()=>{calls++;throw new Error('must not be called');};
  const bytes=Buffer.from('image');
  assert.equal((await inspectOpenAIProvenance(bytes,'image/jpeg',{request,apiKey:'test-only'})).synthid.code,'no_consent');
  assert.equal((await inspectOpenAIProvenance(bytes,'image/jpeg',{consent:true,request,apiKey:''})).synthid.code,'not_configured');
  assert.equal((await inspectOpenAIProvenance(bytes,'text/html',apiOptions(request))).synthid.code,'unsupported_image');
  assert.equal(calls,0);
});

test('利用権限なし・制限・通信/応答エラーは例外やAI判定にせず判定不可',async()=>{
  for(const status of [400,401,403,404,429,500]){
    const checked=await inspectOpenAIProvenance(Buffer.from('image'),'image/jpeg',apiOptions(async()=>({ok:false,status})));
    assert.equal(checked.synthid.status,'unavailable');
    assert.equal(combineProvenance(localUnknown,checked).status,'unknown');
    if(status===404)assert.equal(checked.synthid.code,'access_unavailable');
    if(status===429)assert.equal(checked.synthid.code,'rate_limited');
  }
  for(const request of [async()=>{throw new Error('network');},async()=>({ok:true,json:async()=>{throw new Error('invalid json');}})]){
    assert.equal((await inspectOpenAIProvenance(Buffer.from('image'),'image/jpeg',apiOptions(request))).synthid.code,'request_failed');
  }
  const timeout=await inspectOpenAIProvenance(Buffer.from('image'),'image/jpeg',{...apiOptions(async(url,{signal})=>new Promise((resolve,reject)=>{
    const timer=setTimeout(resolve,1000);
    signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
  })),timeoutMs:5});
  assert.equal(timeout.synthid.code,'request_failed');
});

test('新旧投稿の不明な結果は判定不可。検出方法と発行元を表示しHTMLをエスケープ',()=>{
  for(const provenance of [undefined,...['unknown','verified','not_present','invalid','untrusted','unavailable'].map(status=>({status}))]){
    const html=provenanceHTML({provenance});
    assert.match(html,/AI生成画像の確認 · 判定不可/);
    assert.match(html,/SynthID · 判定不可/);
    assert.doesNotMatch(html,/実写です|本物です/);
  }
  const provenance=combineProvenance({status:'ai_generated',issuer:'<img onerror=alert(1)>',reason:'<script>bad</script>'},remote(noSignal));
  const html=provenanceHTML({provenance});
  assert.match(html,/C2PA · AI生成の記録あり/);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img onerror'));
  assert.match(provenanceHTML({provenance:combineProvenance(localUnknown,remote({object:'content_provenance_check',results:[{type:'synthid',outcome:'detected'}]}))}),/SynthID · OpenAI由来の透かしを検出/);
});

test('投稿API: 元画像検証の結果と同意を保存。未検出/サービス失敗でも投稿できる',async()=>{
  const key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
  const directory=await mkdtemp(path.join(os.tmpdir(),'disaster-provenance-api-'));
  let response=noSignal,calls=0;
  const app=await createApp(directory,undefined,undefined,async()=>null,{deferAnalysis:true,provenanceRequest:async()=>{calls++;if(response==='error')throw new Error('unavailable');return ok(response);}});
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#456'}}).jpeg().withExif({IFD0:{Make:'Test camera'}}).toBuffer();
    const payload={latitude:35,longitude:139,description:'生成元検証テスト',samples:[],image:'data:image/jpeg;base64,'+bytes.toString('base64'),provenance:{status:'ai_generated'}};
    const post=async consent=>{
      const res=await fetch(base+'/api/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,provenance_consent:consent})});
      assert.equal(res.status,201);return (await res.json()).post;
    };
    const unconsented=await post(false);assert.equal(calls,0);assert.equal(unconsented.provenance.status,'unknown');
    assert.equal(unconsented.provenance.synthid.code,'no_consent');
    const negative=await post(true);assert.equal(negative.provenance.status,'unknown');
    assert.equal((await app.store.get(negative.id)).private.provenance_consent,true);
    response={object:'content_provenance_check',results:[{type:'synthid',outcome:'detected'}]};
    const detected=await post(true);assert.equal(detected.provenance.status,'ai_signal');
    response='error';const failure=await post(true);assert.equal(failure.provenance.status,'unknown');
    const stored=(await app.store.get(detected.id)).post;assert.equal(stored.provenance.synthid.status,'detected');
    assert.ok(!('provenance_consent' in stored));
    const image=Buffer.from(await(await fetch(base+detected.image_url)).arrayBuffer());assert.equal((await sharp(image).metadata()).exif,undefined);
    const module=await fetch(base+'/provenance.js');assert.equal(module.status,200);assert.match(await module.text(),/export function provenanceHTML/);
    const form=await(await fetch(base)).text();assert.match(form,/id="provenance-consent" type="checkbox"/);assert.ok(!form.includes('id="provenance-consent" type="checkbox" checked'));
    assert.equal(calls,3);
  }finally{
    await new Promise(resolve=>app.server.close(resolve));await app.store.close();await app.images.close();await rm(directory,{recursive:true,force:true});
    if(key)process.env.OPENAI_API_KEY=key;else delete process.env.OPENAI_API_KEY;
  }
});
