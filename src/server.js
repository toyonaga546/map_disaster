import http from 'node:http';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import exifr from 'exifr';
import { distance, validPoint, gpsResult, priority } from './domain.js';
import { compareImages } from './ai.js';
import { createPostStore } from './post-store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function createApp(directory = path.join(root, 'data'), injectedStore) {
  await mkdir(path.join(directory, 'images'), { recursive: true, mode: 0o700 });
  const store = injectedStore || await createPostStore(directory);
  const hash = token => createHash('sha256').update(token).digest();
  // Only expire old jobs: other servers may be processing recent posts.
  try {
    for (const p of await store.list()) if (p.ai.status === 'pending' && Date.now()-Date.parse(p.created_at)>120000) {
      await store.patch(p.id,{ai:{status:'unavailable',result:'unknown',reason:'検証の待機時間を超過しました。'}});
    }
  } catch (error) { await store.close(); throw error; }
  const imagePath = id => path.join(directory, 'images', `${id}.jpg`);
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if(size > 12_000_000) throw fail(413,'送信データが大きすぎます。写真は8MB以下にしてください。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fail(400,'JSON形式が不正です。'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','geolocation=(self), camera=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET','HEAD'].includes(req.method)) {
        const allowed = process.env.APP_ORIGIN || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== allowed) throw fail(403,'送信元が許可されていません。');
        if (!String(req.headers['content-type']).startsWith('application/json')) throw fail(415,'JSONを送信してください。');
      }
      if (url.pathname === '/api/posts' && req.method === 'GET') return json(res,200,(await store.list()).sort((a,b)=>b.created_at.localeCompare(a.created_at)));
      if (url.pathname === '/api/posts' && req.method === 'POST') {
        const input = await body(req);
        if (!validPoint(input) || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 2000) throw fail(400,'場所と1〜2000文字の説明文が必要です。');
        if (!Array.isArray(input.samples) || input.samples.length > 120) throw fail(400,'GPSデータが不正です。');
        const now = Date.now();
        const samples = input.samples;
        if (samples.some(s => !validPoint(s) || !Number.isFinite(s.accuracy) || s.accuracy < 0 || !Number.isFinite(s.recorded_at) || Math.abs(now-s.recorded_at)>120000)) throw fail(400,'GPSデータが不正です。');
        if (samples.length && Math.max(...samples.map(s=>s.recorded_at))-Math.min(...samples.map(s=>s.recorded_at)) > 31000) throw fail(400,'GPS取得は30秒以内です。');
        if (typeof input.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw fail(400,'JPEG・PNG・WebP写真を選択してください。');
        const raw = Buffer.from(input.image.split(',')[1], 'base64');
        if (!raw.length || raw.length > 8_000_000) throw fail(413,'写真は8MB以下にしてください。');
        let processed;
        try {
          const image = sharp(raw,{ limitInputPixels:40000000 });
          if (!['jpeg','png','webp'].includes((await image.metadata()).format)) throw new Error('format');
          processed = await image.rotate().resize({ width:1600,height:1600,fit:'inside',withoutEnlargement:true }).jpeg({quality:82}).toBuffer();
        }
        catch { throw fail(400,'写真を読み込めません。別の写真を選んでください。'); }
        let metadata = { status:'確認できない', warnings:[] };
        try {
          const exif = await exifr.parse(raw, ['DateTimeOriginal','Make','Model','Software','latitude','longitude']);
          if (exif) {
            const taken = exif.DateTimeOriginal instanceof Date ? exif.DateTimeOriginal.toISOString() : null;
            const warnings = [];
            if (taken && Date.parse(taken)>now) warnings.push('撮影日時が投稿日時より未来です。EXIFのタイムゾーンは不明な場合があります。');
            if (exif.Software) warnings.push('編集ソフトの情報があります。悪意ある改ざんを示すものではありません。');
            if (validPoint(exif) && distance(input,exif)>1000) warnings.push('写真の位置情報と投稿場所が1km以上離れています。');
            metadata = { status:'確認済み', taken_at:taken, camera:[exif.Make,exif.Model].filter(Boolean).join(' '), software:String(exif.Software || '').slice(0,200), location:validPoint(exif)?'記録あり（正確な座標は非公開）':'確認できない', warnings };
          }
        } catch { /* Metadata absence must not prevent posting. */ }
        const id = randomUUID(), token = randomBytes(32).toString('base64url');
        const post = { id, latitude:input.latitude, longitude:input.longitude, description:input.description.trim(), created_at:new Date().toISOString(), image_url:`/images/${id}.jpg`, gps:gpsResult(input,samples), metadata, ai:{status:'pending',result:'unknown',reason:'未検証・解析待ち'} };
        const previous = (await store.listConsenting()).filter(p=>distance(p,post)<=100).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
        await writeFile(imagePath(id),processed,{mode:0o600});
        try { await store.create(post,{token_hash:hash(token).toString('hex'),gps_samples:samples,ai_consent:input.ai_consent===true}); }
        catch (e) { await unlink(imagePath(id)); throw e; }
        json(res,201,{ post, management_token:token });
        const analysis = input.ai_consent === true ? compareImages(imagePath(id),previous?imagePath(previous.id):null) : Promise.resolve({status:'unavailable',result:'unknown',reason:'外部AIへの画像送信に同意されていません。'});
        void analysis.then(ai=>store.patch(id,{ai})).catch(()=>console.error('AI結果の保存に失敗しました。'));
        return;
      }
      const match = url.pathname.match(/^\/api\/posts\/([a-f0-9-]{36})$/);
      if (match) {
        const row = await store.get(match[1]);
        if (!row) throw fail(404,'投稿が見つかりません。');
        const post = row.post;
        if (req.method === 'GET') {
          const history = (await store.list()).filter(p=>distance(post,p)<=100).sort((a,b)=>b.created_at.localeCompare(a.created_at));
          return json(res,200,{ post, history, priority:priority(history).map(p=>p.id) });
        }
        if (!['PATCH','DELETE'].includes(req.method)) throw fail(405,'対応していない操作です。');
        const token = String(req.headers.authorization || '').replace(/^Bearer /,'');
        const tokenHash=row.private?.token_hash;
        if (typeof tokenHash!=='string' || !/^[a-f0-9]{64}$/.test(tokenHash) || !timingSafeEqual(hash(token),Buffer.from(tokenHash,'hex'))) throw fail(403,'管理リンクが無効です。');
        if (req.method === 'DELETE') { await store.delete(post.id); await unlink(imagePath(post.id)).catch(()=>{}); return json(res,200,{deleted:true}); }
        const input = await body(req);
        if (typeof input.description !== 'string' || !input.description.trim() || input.description.length>2000) throw fail(400,'説明文は1〜2000文字です。');
        const updated=await store.patch(post.id,{description:input.description.trim(),updated_at:new Date().toISOString()});
        if (!updated) throw fail(404,'投稿が見つかりません。');
        return json(res,200,updated);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405,'対応していない操作です。');
      const image = url.pathname.match(/^\/images\/([a-f0-9-]{36})\.jpg$/);
      const staticFiles = { '/':'public/index.html', '/app.js':'public/app.js', '/style.css':'public/style.css', '/vendor/leaflet.js':'node_modules/leaflet/dist/leaflet.js', '/vendor/leaflet.css':'node_modules/leaflet/dist/leaflet.css' };
      const file = image ? imagePath(image[1]) : staticFiles[url.pathname] ? path.join(root,staticFiles[url.pathname]) : null;
      if (!file) throw fail(404,'見つかりません。');
      const content = await readFile(file).catch(()=>{throw fail(404,'見つかりません。');});
      const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.jpg':'image/jpeg'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)]}); res.end(req.method==='HEAD'?undefined:content);
    } catch (e) { if (!res.headersSent) json(res,e.status || 500,{error:e.status?e.message:'サーバー処理に失敗しました。'}); else res.end(); }
  });
  return {server,db:store.db,store};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {server} = await createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port,process.env.HOST || '127.0.0.1',()=>console.log(`Local: http://localhost:${port}\nDatabase: ${process.env.DB_DRIVER || 'sqlite'}`));
}
