import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { analyzePost } from '../src/analysis.js';
import { configureEnv } from '../src/functions-runtime.js';

const point = { latitude: 35.68, longitude: 139.76 };
const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#335577' } }).jpeg().toBuffer();
const view = { info: { status: 'available', captured: '2023-05', distance: 12, copyright: '© Google' }, images: [0, 90, 180, 270].map(heading => ({ heading, bytes: jpeg })) };
const payload = (extra = {}) => JSON.stringify({ ...point, description: '現地の状況です。', samples: [], image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, ai_consent: true, ...extra });
const withOpenAI = async run => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only';
  try { return await run(); } finally { if (old) process.env.OPENAI_API_KEY = old; else delete process.env.OPENAI_API_KEY; }
};
const okResponse = (result = 'consistent') => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ result, reason: '建物が共通しています。' }) } }] }) });

// Cloud Functions hands over a request whose body is already read into rawBody.
async function functionsHost(app) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.rawBody = Buffer.concat(chunks);
    app.handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('Cloud Functions環境の設定をランタイムの値から作る', () => {
  const env = configureEnv({ GCLOUD_PROJECT: 'demo-project', FIREBASE_CONFIG: JSON.stringify({ storageBucket: 'demo-bucket.appspot.com' }), DB_DRIVER: 'sqlite' });
  assert.equal(env.DB_DRIVER, 'firestore'); assert.equal(env.STORAGE_DRIVER, 'firebase');
  assert.equal(env.FIREBASE_PROJECT_ID, 'demo-project'); assert.equal(env.FIREBASE_STORAGE_BUCKET, 'demo-bucket.appspot.com');
  assert.equal(env.APP_ORIGIN, 'https://demo-project.web.app');
  const fallback = configureEnv({ GCLOUD_PROJECT: 'demo-project', FIREBASE_CONFIG: 'not json', APP_ORIGIN: 'https://example.test' });
  assert.equal(fallback.FIREBASE_STORAGE_BUCKET, 'demo-project.firebasestorage.app'); assert.equal(fallback.APP_ORIGIN, 'https://example.test');
});

test('本文を読み取り済みのリクエスト(rawBody)でも投稿でき、AI解析は後続のトリガーで行う', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disaster-functions-'));
  const app = await createApp(dir, undefined, undefined, async () => view, { deferAnalysis: true });
  const { server, base } = await functionsHost(app);
  try {
    const response = await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload() });
    assert.equal(response.status, 201);
    const { post } = await response.json();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await app.store.get(post.id)).post.ai.status, 'pending');
    // The Firestore trigger runs the analysis; without an API key it reports why.
    assert.equal((await app.runAnalysis(post.id)).status, 'unavailable');
    assert.match((await app.store.get(post.id)).post.ai.reason, /APIキー/);
    assert.equal(await app.runAnalysis(post.id), null);
  } finally {
    await new Promise(resolve => server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('AI解析：保存済みの写真と4方向のストリートビュー画像を読み出して比較し、同意がなければ送らない', async () => withOpenAI(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disaster-analysis-'));
  const app = await createApp(dir, undefined, undefined, async () => view, { deferAnalysis: true });
  const { server, base } = await functionsHost(app);
  const post = async extra => (await (await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload(extra) })).json()).post;
  const analyze = (p, consent, request) => analyzePost({ store: app.store, imageStoreFor: () => app.images, post: p, consent, request });
  try {
    const first = await post();
    const sent = [];
    const request = async (url, options) => { sent.push(JSON.parse(options.body)); return okResponse(); };
    assert.equal((await analyze((await app.store.get(first.id)).post, true, request)).result, 'consistent');
    assert.equal(sent[0].messages[1].content.length, 5);
    const second = await post();
    assert.equal((await analyze((await app.store.get(second.id)).post, true, request)).status, 'complete');
    assert.equal(sent[1].messages[1].content.length, 6);
    assert.equal((await analyze(second, false, request)).status, 'unavailable');
    assert.equal(sent.length, 2);
    assert.match((await analyze({ ...second, id: '00000000-0000-0000-0000-000000000000' }, true, request)).reason, /取得できません/);
  } finally {
    await new Promise(resolve => server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true });
  }
}));
