import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { bearing } from '../src/domain.js';
import { fetchStreetView } from '../src/streetview.js';
import { compareImages } from '../src/ai.js';
import { createApp } from '../src/server.js';

const point = { latitude: 35.68, longitude: 139.76 };
const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#335577' } }).jpeg().toBuffer();
const withKey = async run => {
  const old = process.env.GOOGLE_MAPS_API_KEY; process.env.GOOGLE_MAPS_API_KEY = 'test-only';
  try { return await run(); } finally { if (old) process.env.GOOGLE_MAPS_API_KEY = old; else delete process.env.GOOGLE_MAPS_API_KEY; }
};
const imageResponse = (type = 'image/jpeg', body = jpeg) => ({ ok: true, headers: { get: () => type }, arrayBuffer: async () => body });
const metaResponse = value => ({ ok: true, json: async () => value });

test('方位角は北・東・南・西を正しく返す', () => {
  const origin = { latitude: 0, longitude: 0 };
  assert.ok(Math.abs(bearing(origin, { latitude: 1, longitude: 0 }) - 0) < 0.01);
  assert.ok(Math.abs(bearing(origin, { latitude: 0, longitude: 1 }) - 90) < 0.01);
  assert.ok(Math.abs(bearing(origin, { latitude: -1, longitude: 0 }) - 180) < 0.01);
  assert.ok(Math.abs(bearing(origin, { latitude: 0, longitude: -1 }) - 270) < 0.01);
});

test('ストリートビュー取得：成功時は撮影地点から投稿地点の方向を向く', async () => {
  const urls = [];
  const result = await withKey(() => fetchStreetView(point, async url => {
    urls.push(new URL(url));
    return urls.length === 1 ? metaResponse({ status: 'OK', pano_id: 'pano1', date: '2023-05', location: { lat: 35.68, lng: 139.7595 }, copyright: '© Google' }) : imageResponse();
  }));
  assert.equal(result.info.status, 'available');
  assert.equal(result.info.captured, '2023-05');
  assert.equal(result.bytes.length, jpeg.length);
  assert.ok(result.info.distance > 30 && result.info.distance < 60);
  assert.equal(urls[0].pathname.endsWith('/metadata'), true);
  assert.equal(urls[1].searchParams.get('pano'), 'pano1');
  assert.equal(urls[1].searchParams.get('heading'), '90');
  assert.equal(urls[1].searchParams.get('return_error_code'), 'true');
});

test('ストリートビュー取得：キー未設定・画像なし・API失敗・画像でない応答は取得不可になり例外を出さない', async () => {
  assert.equal((await fetchStreetView(point, async () => { throw new Error('must not be called'); })).info.status, 'unavailable');
  await withKey(async () => {
    const none = await fetchStreetView(point, async () => metaResponse({ status: 'ZERO_RESULTS' }));
    assert.equal(none.info.status, 'unavailable'); assert.match(none.info.reason, /50m以内/);
    assert.equal((await fetchStreetView(point, async () => metaResponse({ status: 'REQUEST_DENIED' }))).info.status, 'unavailable');
    assert.equal((await fetchStreetView(point, async () => { throw new Error('timeout'); })).info.status, 'unavailable');
    let calls = 0;
    const notImage = await fetchStreetView(point, async () => ++calls === 1 ? metaResponse({ status: 'OK', pano_id: 'p', location: { lat: 35.68, lng: 139.76 } }) : imageResponse('text/html'));
    assert.equal(notImage.info.status, 'unavailable'); assert.equal(notImage.bytes, null);
  });
});

test('AI比較：ストリートビュー画像だけでも送信し、過去写真があれば両方を送る', async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only';
  try {
    const sent = [];
    const request = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ result: 'consistent', reason: 'ストリートビューと建物が共通しています。' }) } }] }) }; };
    assert.equal((await compareImages(jpeg, null, request, jpeg)).result, 'consistent');
    assert.equal(sent[0].messages[1].content.length, 2);
    assert.match(sent[0].messages[0].content, /Street View/);
    await compareImages(jpeg, jpeg, request, jpeg);
    assert.equal(sent[1].messages[1].content.length, 3);
    assert.equal((await compareImages(jpeg, null, request, null)).status, 'unavailable');
  } finally { if (old) process.env.OPENAI_API_KEY = old; else delete process.env.OPENAI_API_KEY; }
});

test('投稿にストリートビュー画像を保存・配信し、削除時に消す', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disaster-streetview-'));
  let view = { info: { status: 'available', captured: '2023-05', distance: 12, copyright: '© Google' }, bytes: jpeg };
  const app = await createApp(dir, undefined, undefined, async () => { if (view instanceof Error) throw view; return view; });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async () => {
    const response = await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...point, description: '現地の状況です。', samples: [], image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, ai_consent: false }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await post();
    assert.equal(created.status, 201);
    const { post: p, management_token: token } = created.body;
    assert.equal(p.streetview.status, 'available');
    assert.equal(p.streetview.image_url, `/images/${p.id}.streetview.jpg`);
    const image = await fetch(base + p.streetview.image_url);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal((await fetch(base + `/api/posts/${p.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(base + p.streetview.image_url)).status, 404);
    assert.equal((await fetch(base + p.image_url)).status, 404);

    view = { info: { status: 'unavailable', reason: '投稿地点の50m以内にストリートビューがありません。' }, bytes: null };
    const none = (await post()).body.post;
    assert.equal(none.streetview.status, 'unavailable');
    assert.equal((await fetch(base + `/images/${none.id}.streetview.jpg`)).status, 404);

    view = new Error('boom');
    const failed = await post();
    assert.equal(failed.status, 201); assert.equal(failed.body.post.streetview.status, 'unavailable');
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true });
  }
});
